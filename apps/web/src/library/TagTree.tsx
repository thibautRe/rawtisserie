/**
 * The Tags filter, which is also where tags are managed (as collections are, roadmap
 * 8.14; the tag manager page it replaces was Settings › Tags). Every tag is listed,
 * those no photo has yet too, with the photos under it under the other filters. Each
 * row's menu edits it (its path: renaming, moving, merging; its shortcut), makes one
 * inside it, or deletes it, saying first what that does (`TagEditor`, `tagManager.ts`).
 */
import { Box, Button, Checkbox, HStack, IconButton, Menu, Portal, Stack, Text } from '@chakra-ui/react';
import { ChevronDown, ChevronRight, CornerDownRight, Ellipsis, Keyboard, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTagChange, useTagManager } from '../api/hooks.ts';
import type { FacetValue } from '@rawtisserie/api';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { TagSearch } from '../components/TagSearch.tsx';
import { toaster } from '../components/toaster.tsx';
import { formatShortcut } from '../lib/keys.ts';
import { type TagInfo, describeDelete, managedTags, plural } from '../lib/tagManager.ts';
import { SEPARATOR, type TagNode, displayTag, filterTagTree, isUnder, retag, tagTree } from '../lib/tags.ts';
import { type EditorTarget, TagEditor } from './TagEditor.tsx';
import { TOP_LEVEL, cycleTag, isAny, setUntagged, tagGroups, tagState, toggleAny } from './tagFilter.ts';
import type { LibrarySearch } from './useLibrarySearch.ts';

/** Tags shown at each level before "Show more" (a search finds the rest). */
export const TAGS_SHOWN = 10;

const NUMERIC = { fontFamily: 'numeric', fontVariantNumeric: 'tabular-nums' } as const;
const TAG_KEYS = ['tag', 'notTag', 'tagAny'] as const;

/**
 * Managing tags from the filters: the editor and the delete confirmation, opened from a
 * row's menu or the block's "New tag". The filters follow a tag renamed or deleted.
 */
export function useTagManagement(search: LibrarySearch) {
  const { data } = useTagManager();
  const change = useTagChange();
  const { tree, info } = useMemo(
    () => (data ? managedTags(data) : { tree: [] as TagNode[], info: new Map<string, TagInfo>() }),
    [data],
  );
  const [editing, setEditing] = useState<EditorTarget | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  /** The filters' tags, `map`ped (null: dropped). */
  const follow = (map: (tag: string) => string | null) =>
    search.edit((next) => {
      for (const key of TAG_KEYS) {
        const values = next.getAll(key);
        // `tagAny` names groups: `|` (the top level) isn't a tag.
        const mapped = values.map((v) => (key === 'tagAny' && v === TOP_LEVEL ? v : map(v)));
        if (mapped.every((m, i) => m === values[i])) continue;
        next.delete(key);
        for (const v of new Set(mapped)) if (v !== null) next.append(key, v);
      }
    });

  const dialogs = (
    <>
      <TagEditor
        target={editing}
        info={info}
        onClose={() => setEditing(null)}
        onRenamed={(from, to) => follow((t) => (isUnder(t, from) ? retag(t, from, to) : t))}
      />
      <ConfirmDialog
        text={
          deleting && info.has(deleting)
            ? { title: `Delete ${displayTag(deleting)}?`, body: describeDelete(deleting, info) }
            : null
        }
        confirm="Delete"
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          const tag = deleting!;
          setDeleting(null);
          change.mutate(
            { type: 'delete', tag },
            {
              onSuccess: (n) => {
                follow((t) => (isUnder(t, tag) ? null : t));
                toaster.create({
                  type: 'success',
                  title: `Deleted ${displayTag(tag)}${n ? ` from ${plural(n, 'photo')}` : ''}`,
                });
              },
              onError: (err) =>
                toaster.create({ type: 'error', title: 'Could not delete it', description: err.message }),
            },
          );
        }}
      />
    </>
  );
  return { tree, info, edit: setEditing, remove: setDeleting, dialogs };
}

/**
 * The tags as a tree: a click on a tag shows the photos with it or one under it
 * (`People`: all of People's), again those without it, again all. Picked tags with the
 * same parent go together: all of them, or any (the switch on the parent, or above the
 * tree for top-level tags); different parents' must all match. An excluded tag leaves
 * out photos with it, except for the picked tags under it (`People › Alice` picked and
 * `People` excluded: Alice and nobody else). Folded below the top, except where a tag is
 * picked or excluded, and while searching: then it shows the tags found and the way to
 * them. It doesn't scroll on its own: each level shows `TAGS_SHOWN` tags (and those in
 * the filters), the rest behind "Show more". "No tags" picks the photos without any, and
 * can't go with a picked tag (nothing would match): picking one unpicks the other.
 */
export function TagTree({
  values,
  untagged,
  search,
  manage,
}: {
  /** Each level with the photos under it, under the other filters (the facets'). */
  values: FacetValue[];
  untagged: number;
  search: LibrarySearch;
  manage: ReturnType<typeof useTagManagement>;
}) {
  const p = search.params;
  const picked = p.getAll('tag');
  const excluded = p.getAll('notTag');
  const used = [...picked, ...excluded];
  const groups = tagGroups(p);
  const noTags = p.get('untagged') === 'true';
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  // Levels showing all their tags (by parent path; '' for the top).
  const [more, setMore] = useState<ReadonlySet<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const searching = query.trim() !== '';
  // Every tag (those no photo has under these filters, or at all, at 0), and those in the filters.
  const tree = useMemo(() => {
    const counts = new Map(values.map((v) => [v.value, v.count]));
    const all = new Set([...values.map((v) => v.value), ...manage.info.keys(), ...used]);
    return tagTree([...all].map((value) => ({ value, count: counts.get(value) ?? 0 })));
  }, [values, manage.info, used.join('\0')]); // eslint-disable-line react-hooks/exhaustive-deps
  // Unfolded to show a tag in the filters: they stay unfolded once it's out (Clear all).
  useEffect(() => {
    const holding = used.flatMap((tag) => {
      const levels = tag.split(SEPARATOR);
      return levels.slice(1).map((_, i) => levels.slice(0, i + 1).join(SEPARATOR));
    });
    if (holding.some((t) => !open.has(t))) setOpen((o) => new Set([...o, ...holding]));
  }, [used.join('\0')]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!tree.length && !noTags)
    return (
      <Text textStyle="xs" color="fg.subtle">
        No tags yet: add some to photos, or{' '}
        <Button
          variant="plain"
          size="xs"
          h="auto"
          p="0"
          color="orange.fg"
          onClick={() => manage.edit({ parent: null })}
        >
          make one
        </Button>
        .
      </Text>
    );
  const toggle = (set: typeof setOpen, key: string) =>
    set((o) => {
      const next = new Set(o);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const holdsUsed = (n: TagNode) => used.some((s) => s !== n.path && isUnder(s, n.path));
  /** All or any of a group's picked tags, when it has several. */
  const groupSwitch = (group: string) =>
    (groups.get(group)?.length ?? 0) > 1 && (
      <AnySwitch any={isAny(p, group)} onToggle={() => search.edit((next) => toggleAny(next, group))} />
    );
  const level = (nodes: TagNode[], depth: number, parent: string): React.ReactNode[] => {
    const all = searching || more.has(parent);
    const shown = all ? nodes : nodes.filter((n, i) => i < TAGS_SHOWN || used.includes(n.path) || holdsUsed(n));
    const hidden = nodes.length - shown.length;
    return [
      ...shown.flatMap((n) => {
        // Open by the user, holding a tag in the filters, or searched.
        const unfolded = searching || open.has(n.path) || holdsUsed(n);
        const state = tagState(p, n.path);
        const shortcut = manage.info.get(n.path)?.shortcut;
        return [
          <HStack
            key={n.path}
            gap="1"
            ps={`${depth * 14}px`}
            data-tag={n.path}
            data-state={state ?? undefined}
            css={{
              '& [data-row-menu]': { opacity: { base: 1, md: 0 } },
              '&:hover [data-row-menu], &:focus-within [data-row-menu], & [data-row-menu][data-state=open]': {
                opacity: 1,
              },
            }}
          >
            {n.children.length ? (
              <IconButton
                size="2xs"
                variant="ghost"
                minW="4"
                h="4"
                aria-label={unfolded ? `Fold ${n.name}` : `Unfold ${n.name}`}
                disabled={searching}
                onClick={() => toggle(setOpen, n.path)}
              >
                {unfolded ? <ChevronDown /> : <ChevronRight />}
              </IconButton>
            ) : (
              <Box w="4" flexShrink={0} />
            )}
            <Checkbox.Root
              size="xs"
              flex="1"
              minW="0"
              colorPalette={state === 'exclude' ? 'red' : undefined}
              checked={state === 'include' ? true : state === 'exclude' ? 'indeterminate' : false}
              title={
                (state === 'include'
                  ? `With ${displayTag(n.path)}: click for the photos without it`
                  : state === 'exclude'
                    ? `Without ${displayTag(n.path)}: click to stop filtering by it`
                    : `${displayTag(n.path)}: click for the photos with it, twice for those without`) +
                (shortcut ? ` · ${formatShortcut(shortcut)} adds or removes it` : '')
              }
              onCheckedChange={() => search.edit((next) => cycleTag(next, n.path))}
            >
              <Checkbox.HiddenInput />
              <Checkbox.Control />
              <Checkbox.Label
                flex="1"
                truncate
                textStyle="xs"
                textDecoration={state === 'exclude' ? 'line-through' : undefined}
                color={state === 'exclude' || !n.count ? 'fg.muted' : undefined}
              >
                {n.name}
              </Checkbox.Label>
              <Text textStyle="xs" color="fg.muted" {...NUMERIC}>
                {n.count}
              </Text>
            </Checkbox.Root>
            {groupSwitch(n.path)}
            <Menu.Root
              onSelect={({ value }) => {
                if (value === 'edit') manage.edit({ tag: n.path });
                else if (value === 'shortcut') manage.edit({ tag: n.path, focus: 'shortcut' });
                else if (value === 'create') manage.edit({ parent: n.path });
                else if (value === 'delete') manage.remove(n.path);
              }}
            >
              <Menu.Trigger asChild>
                <IconButton
                  data-row-menu
                  size="2xs"
                  variant="ghost"
                  minW="4"
                  h="4"
                  color="fg.muted"
                  aria-label={`Manage ${n.name}`}
                >
                  <Ellipsis />
                </IconButton>
              </Menu.Trigger>
              <Portal>
                <Menu.Positioner>
                  <Menu.Content minW="52">
                    <Menu.Item value="edit">
                      <Pencil /> Edit…
                    </Menu.Item>
                    <Menu.Item value="shortcut">
                      <Keyboard /> {shortcut ? 'Shortcut' : 'Give it a shortcut…'}
                      {shortcut && <Menu.ItemCommand>{formatShortcut(shortcut)}</Menu.ItemCommand>}
                    </Menu.Item>
                    <Menu.Item value="create">
                      <CornerDownRight /> New tag inside…
                    </Menu.Item>
                    <Menu.Separator />
                    <Menu.Item value="delete" color="fg.error" _highlighted={{ bg: 'bg.error', color: 'fg.error' }}>
                      <Trash2 /> Delete…
                    </Menu.Item>
                  </Menu.Content>
                </Menu.Positioner>
              </Portal>
            </Menu.Root>
          </HStack>,
          ...(unfolded ? level(n.children, depth + 1, n.path) : []),
        ];
      }),
      ...(hidden > 0 || (more.has(parent) && !searching && nodes.length > TAGS_SHOWN)
        ? [
            <Button
              key={`more-${parent}`}
              size="2xs"
              variant="ghost"
              color="fg.muted"
              alignSelf="start"
              ms={`${depth * 14 + 20}px`}
              px="1"
              onClick={() => toggle(setMore, parent)}
            >
              {hidden > 0 ? `Show ${hidden} more` : 'Show fewer'}
            </Button>,
          ]
        : []),
    ];
  };
  const found = filterTagTree(tree, query);
  return (
    <Stack gap="2">
      <TagSearch size="xs" value={query} onChange={setQuery} />
      {!searching && (
        <Checkbox.Root
          size="xs"
          ps="5"
          checked={noTags}
          onCheckedChange={() => search.edit((next) => setUntagged(next, !noTags))}
        >
          <Checkbox.HiddenInput />
          <Checkbox.Control />
          <Checkbox.Label flex="1" textStyle="xs" fontStyle="italic">
            No tags
          </Checkbox.Label>
          <Text textStyle="xs" color="fg.muted" {...NUMERIC} me="5">
            {untagged}
          </Text>
        </Checkbox.Root>
      )}
      {groupSwitch(TOP_LEVEL) && (
        <HStack ps="5" justify="space-between">
          <Text textStyle="xs" color="fg.muted">
            Top-level tags
          </Text>
          {groupSwitch(TOP_LEVEL)}
        </HStack>
      )}
      {found.length ? (
        <Stack gap="1">{level(found, 0, '')}</Stack>
      ) : (
        <Text textStyle="xs" color="fg.subtle">
          No tag matches
        </Text>
      )}
    </Stack>
  );
}

/** A group's picked tags: all of them, or any. */
function AnySwitch({ any, onToggle }: { any: boolean; onToggle: () => void }) {
  return (
    <Button
      size="2xs"
      variant="outline"
      h="4"
      minW="8"
      px="1"
      textStyle="label"
      flexShrink={0}
      title={
        any
          ? 'Photos with any of the tags picked under it: click for all of them'
          : 'Photos with all of the tags picked under it: click for any of them'
      }
      onClick={onToggle}
    >
      {any ? 'any' : 'all'}
    </Button>
  );
}
