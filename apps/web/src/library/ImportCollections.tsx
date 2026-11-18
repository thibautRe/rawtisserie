/**
 * The import review's collections (roadmap 8.14): how the new photos are sorted into
 * collections, whatever their folders (`importCollections.ts`), and what that makes:
 * each collection with its photos and dates, new or added to, renamed in place.
 */
import { Box, Button, Checkbox, HStack, Input, NativeSelect, Stack, Text } from '@chakra-ui/react';
import { Folder, FolderOpen } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useCollections } from '../api/hooks.ts';
import { collectionPath, displayCollection, normalizeCollectionName } from '../lib/collections.ts';
import type { CaptureTime } from './captureTime.ts';
import { CollectionPicker, type PickerRequest } from './CollectionPicker.tsx';
import { type SortMode, type Sorting, hasFolders, planCollections } from './importCollections.ts';
import type { PickedFile } from './pickedFiles.ts';

const MODES: { value: SortMode; label: string }[] = [
  { value: 'day', label: 'One collection per day' },
  { value: 'gap', label: 'One collection per shoot' },
  { value: 'folders', label: 'As in the folders' },
  { value: 'one', label: 'All in one collection' },
  { value: 'none', label: 'In no collection' },
];

/** Collections listed before "and N more". */
const SHOWN = 8;

const NUMERIC = { fontFamily: 'numeric', fontVariantNumeric: 'tabular-nums' } as const;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** `2026-11-09T18:00:00`…`2026-11-10T01:30:00` → "9 Nov 18:00 – 10 Nov 01:30". */
function span(from: CaptureTime, to: CaptureTime) {
  if (!from) return '';
  const at = (t: CaptureTime) => {
    const d = new Date(`${t}Z`);
    return {
      day: d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }),
      time: t.slice(11, 16),
    };
  };
  const [a, b] = [at(from), at(to)];
  if (from === to) return `${a.day} ${a.time}`;
  return a.day === b.day ? `${a.day} ${a.time}–${b.time}` : `${a.day} ${a.time} – ${b.day} ${b.time}`;
}

export function ImportCollections({
  files,
  times,
  sorting,
  label,
  onChange,
}: {
  /** The new photos. */
  files: readonly PickedFile[];
  times: ReadonlyMap<PickedFile, CaptureTime>;
  sorting: Sorting;
  /** The folder picked, if one: the default name of "all in one". */
  label: string | null;
  /** None: shown, not changed (`/ui`). */
  onChange?: (sorting: Sorting) => void;
}) {
  const { data: list = [] } = useCollections();
  const [picker, setPicker] = useState<PickerRequest | null>(null);
  const plan = useMemo(() => planCollections(files, times, sorting), [files, times, sorting]);
  const existing = useMemo(() => {
    const byId = new Map(list.map((c) => [c.id, c]));
    return new Set(list.map((c) => collectionPath(byId, c.id).join('\0')));
  }, [list]);
  const set = (patch: Partial<Sorting>) => onChange?.({ ...sorting, ...patch });
  const folders = hasFolders(files);
  const dated = sorting.mode === 'day' || sorting.mode === 'gap';
  const left = files.length - [...plan.of.keys()].length;
  const fresh = plan.groups.filter((g) => !existing.has(g.path.join('\0'))).length;

  return (
    <Stack gap="2" pt="3" borderTopWidth="1px" data-import-collections>
      <HStack justify="space-between" gap="3">
        <Text fontWeight="semibold">Collections</Text>
        <NativeSelect.Root size="xs" maxW="56" disabled={!onChange}>
          <NativeSelect.Field
            aria-label="Sort the new photos into collections"
            value={sorting.mode}
            onChange={(e) => {
              const mode = e.target.value as SortMode;
              set({ mode, ...(mode === 'one' && !sorting.one.length && label && { one: [label] }) });
            }}
          >
            {MODES.map((m) => (
              <option key={m.value} value={m.value} disabled={m.value === 'folders' && !folders}>
                {m.label}
              </option>
            ))}
          </NativeSelect.Field>
          <NativeSelect.Indicator />
        </NativeSelect.Root>
      </HStack>

      {sorting.mode === 'gap' && (
        <HStack gap="2" textStyle="xs" color="fg.muted">
          <Text>A new one after</Text>
          <Input
            size="2xs"
            type="number"
            w="14"
            min={0.25}
            step={0.5}
            value={sorting.gapHours}
            aria-label="Hours without photos"
            disabled={!onChange}
            onChange={(e) => {
              const hours = Number(e.target.value);
              if (hours > 0) set({ gapHours: hours });
            }}
            {...NUMERIC}
          />
          <Text>hours without photos</Text>
        </HStack>
      )}
      {dated && (
        <Checkbox.Root
          size="xs"
          checked={sorting.byYear}
          disabled={!onChange}
          onCheckedChange={(e) => set({ byYear: !!e.checked })}
        >
          <Checkbox.HiddenInput />
          <Checkbox.Control />
          <Checkbox.Label fontWeight="normal" textStyle="xs">
            Inside a collection per year
          </Checkbox.Label>
        </Checkbox.Root>
      )}
      {sorting.mode === 'one' && (
        <HStack gap="2">
          {sorting.one.length > 1 ? (
            // One picked inside another: its path, changed by picking again or cleared.
            <HStack flex="1" minW="0" gap="1" textStyle="xs">
              <Text truncate>{displayCollection(sorting.one)}</Text>
              <Button size="2xs" variant="ghost" color="fg.muted" onClick={() => set({ one: [] })}>
                Clear
              </Button>
            </HStack>
          ) : (
            <Input
              size="xs"
              placeholder="Collection’s name"
              aria-label="Collection’s name"
              value={sorting.one[0] ?? ''}
              disabled={!onChange}
              // Typed: a collection at the top level, made if it isn't there.
              onChange={(e) => set({ one: e.target.value.trim() ? [e.target.value] : [] })}
            />
          )}
          <Button
            size="xs"
            variant="outline"
            flexShrink={0}
            disabled={!onChange}
            onClick={() =>
              setPicker({
                title: 'Import into…',
                confirm: 'Pick',
                none: null,
                onPick: (id) => {
                  if (!id) return;
                  const byId = new Map(list.map((c) => [c.id, c]));
                  set({ one: collectionPath(byId, id) });
                },
              })
            }
          >
            <FolderOpen /> Pick one…
          </Button>
        </HStack>
      )}

      {plan.groups.length > 0 && (
        <Stack gap="1" data-planned>
          {plan.groups.slice(0, SHOWN).map((g) => {
            const known = existing.has(g.path.join('\0'));
            const parent = g.path.slice(0, -1);
            return (
              <HStack key={g.key} gap="2" textStyle="xs" data-group={g.path.join('/')}>
                <Box color={known ? 'fg.muted' : 'orange.fg'} flexShrink={0}>
                  <Folder size={13} />
                </Box>
                {parent.length > 0 && (
                  <Text color="fg.muted" flexShrink={0}>
                    {displayCollection(parent)} ›
                  </Text>
                )}
                {dated ? (
                  <Input
                    size="2xs"
                    variant="flushed"
                    flex="1"
                    minW="20"
                    value={sorting.names[g.key] ?? g.defaultName}
                    aria-label={`Name of ${g.defaultName}`}
                    disabled={!onChange}
                    onChange={(e) => set({ names: { ...sorting.names, [g.key]: e.target.value } })}
                    onBlur={(e) => {
                      if (!normalizeCollectionName(e.target.value)) {
                        const { [g.key]: _, ...names } = sorting.names;
                        set({ names });
                      }
                    }}
                  />
                ) : (
                  <Text flex="1" truncate>
                    {g.path.at(-1)}
                  </Text>
                )}
                <Text color="fg.muted" flexShrink={0} hideBelow="sm">
                  {span(g.from, g.to)}
                </Text>
                <Text color="fg.muted" flexShrink={0} {...NUMERIC} title={known ? 'Added to it' : 'Made by the import'}>
                  {known ? '+' : ''}
                  {g.files.toLocaleString()}
                </Text>
              </HStack>
            );
          })}
          {plan.groups.length > SHOWN && (
            <Text textStyle="xs" color="fg.muted" ps="5">
              and {plural(plan.groups.length - SHOWN, 'more collection')}
            </Text>
          )}
        </Stack>
      )}
      <Text textStyle="xs" color="fg.muted">
        {[
          plan.groups.length
            ? fresh === plan.groups.length
              ? `${plural(fresh, 'new collection')}`
              : fresh
                ? `${plural(fresh, 'new collection')}, ${plural(plan.groups.length - fresh, 'added to')}`
                : `Added to ${plural(plan.groups.length, 'collection')} you have`
            : null,
          left && sorting.mode !== 'none' ? `${plural(left, 'photo')} in no collection (no folder)` : null,
          sorting.mode === 'none' ? 'Sort them later from the library' : null,
          sorting.mode === 'one' && !sorting.one.length ? 'Name it, or pick one you have' : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </Text>
      <CollectionPicker request={picker} onClose={() => setPicker(null)} />
    </Stack>
  );
}
