/**
 * The library's collections filter (roadmap 8.14): the tree of collections, each with its
 * photos and those under it (under the other filters), picked like tags (any of the
 * picked ones; one picks those under it too). It doesn't scroll on its own in the
 * sidebar: each level shows its most recent collections and those holding a picked one,
 * the rest behind "Show more", and a search finds any. Each row's menu makes, renames,
 * moves, merges and deletes collections.
 */
import { Box, Button, Checkbox, HStack, IconButton, Menu, Portal, Stack, Text } from '@chakra-ui/react';
import {
  ChevronDown,
  ChevronRight,
  Combine,
  CornerDownRight,
  Ellipsis,
  FolderInput,
  Pencil,
  Trash2,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useCollectionChange, useCollections } from '../api/hooks.ts';
import type { FacetValue } from '../api/types.ts';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { RenameDialog } from '../components/RenameDialog.tsx';
import { TagSearch } from '../components/TagSearch.tsx';
import { toaster } from '../components/toaster.tsx';
import {
  type CollectionNode,
  NO_COLLECTION,
  collectionIndex,
  collectionPath,
  collectionTree,
  displayCollection,
  filterCollectionTree,
  isWithin,
  collectionNameProblem,
  normalizeCollectionName,
} from '../lib/collections.ts';
import { CollectionPicker, type PickerRequest } from './CollectionPicker.tsx';
import type { LibrarySearch } from './useLibrarySearch.ts';

/** Collections shown at each level before "Show more". */
export const COLLECTIONS_SHOWN = 6;

const NUMERIC = { fontFamily: 'numeric', fontVariantNumeric: 'tabular-nums' } as const;

type Naming = { title: string; action: string; name: string | null; hint: string; onName: (name: string) => void };

/** "New collection" for the block's header: one at the top level. */
export function useNewCollection() {
  const change = useCollectionChange();
  const [naming, setNaming] = useState<Naming | null>(null);
  const open = (parentId: string | null, parentName?: string) =>
    setNaming({
      title: parentName ? `New collection in ${parentName}` : 'New collection',
      action: 'Make',
      name: null,
      hint: 'Names are unique within the collection they’re in, and can’t have “|”.',
      onName: (name) =>
        change.mutate(
          { type: 'create', name, parentId },
          { onError: (err) => toaster.create({ type: 'error', title: 'Could not make it', description: err.message }) },
        ),
    });
  const dialog = (
    <RenameDialog
      open={!!naming}
      title={naming?.title ?? ''}
      action={naming?.action}
      hint={naming?.hint ?? ''}
      name={naming?.name ?? null}
      placeholder="Name"
      maxLength={200}
      onClose={() => setNaming(null)}
      onRename={(name) => {
        const n = name && normalizeCollectionName(name);
        if (!n || n === naming?.name) return;
        const problem = collectionNameProblem(n);
        if (problem) toaster.create({ type: 'error', title: problem, description: 'Use another character, as “-”.' });
        else naming?.onName(n);
      }}
    />
  );
  return { open, setNaming, dialog };
}

export function CollectionFilter({
  counts,
  search,
  naming,
}: {
  /** Each collection's own photos under the other filters (the facets'); null for none. */
  counts: FacetValue<string | null>[];
  search: LibrarySearch;
  naming: ReturnType<typeof useNewCollection>;
}) {
  const { data: list } = useCollections();
  const change = useCollectionChange();
  const picked = search.params.getAll('collection');
  const counted = useMemo(() => new Map(counts.filter((c) => c.value).map((c) => [c.value!, c.count])), [counts]);
  const tree = useMemo(() => collectionTree(list ?? [], counted), [list, counted]);
  const byId = useMemo(() => collectionIndex(tree), [tree]);
  const none = counts.find((c) => c.value === null)?.count ?? 0;
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  // Levels showing all their collections (by parent id; '' for the top).
  const [more, setMore] = useState<ReadonlySet<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const [picker, setPicker] = useState<PickerRequest | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; body: string; action: string; run: () => void } | null>(null);
  const searching = query.trim() !== '';
  const holdsPicked = (n: CollectionNode) => picked.some((id) => id !== n.id && isWithin(byId, id, n.id));

  if (!list) return null;
  if (!list.length && !picked.includes(NO_COLLECTION))
    return (
      <Text textStyle="xs" color="fg.subtle">
        No collections yet: imports can make them, or{' '}
        <Button variant="plain" size="xs" h="auto" p="0" color="orange.fg" onClick={() => naming.open(null)}>
          make one
        </Button>
        .
      </Text>
    );

  const failed = (title: string) => (err: Error) => toaster.create({ type: 'error', title, description: err.message });
  const act = (n: CollectionNode, action: string) => {
    const path = displayCollection(collectionPath(byId, n.id));
    if (action === 'new') naming.open(n.id, n.name);
    else if (action === 'rename')
      naming.setNaming({
        title: `Edit ${n.name}`,
        action: 'Save',
        name: n.name,
        hint: 'Names are unique within the collection they’re in, and can’t have “|”.',
        onName: (name) => change.mutate({ type: 'rename', id: n.id, name }, { onError: failed('Could not rename it') }),
      });
    else if (action === 'move')
      setPicker({
        title: `Move ${n.name} into…`,
        confirm: 'Move',
        current: n.parentId,
        exclude: n.id,
        none: { label: 'The top level', hint: 'Not inside another collection' },
        onPick: (parentId) =>
          change.mutate({ type: 'move', id: n.id, parentId }, { onError: failed('Could not move it') }),
      });
    else if (action === 'merge')
      setPicker({
        title: `Merge ${n.name} into…`,
        confirm: 'Merge',
        exclude: n.id,
        none: null,
        onPick: (into) =>
          into &&
          setConfirm({
            title: `Merge ${n.name} into ${byId.get(into)?.name}?`,
            body: `Its ${n.total === 1 ? 'photo goes' : `${n.total} photos go`} into ${displayCollection(collectionPath(byId, into))}, with the collections in it (those of the same name merged too), and ${path} is gone.`,
            action: 'Merge',
            run: () => {
              change.mutate({ type: 'merge', id: n.id, into }, { onError: failed('Could not merge it') });
              if (picked.includes(n.id)) search.toggle('collection', n.id);
            },
          }),
      });
    else if (action === 'delete')
      setConfirm({
        title: `Delete ${n.name}?`,
        body: `${n.children.length ? 'It and the collections in it are' : 'It’s'} gone; ${
          n.total === 1 ? 'its photo stays' : `its ${n.total} photos stay`
        } in the library, in no collection.`,
        action: 'Delete',
        run: () => {
          change.mutate({ type: 'delete', id: n.id }, { onError: failed('Could not delete it') });
          search.edit((next) => {
            const kept = next.getAll('collection').filter((id) => !isWithin(byId, id, n.id));
            next.delete('collection');
            for (const id of kept) next.append('collection', id);
          });
        },
      });
  };

  const toggle = (id: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const level = (nodes: CollectionNode[], depth: number, parent: string): React.ReactNode[] => {
    const all = searching || more.has(parent);
    const shown = all
      ? nodes
      : nodes.filter((n, i) => i < COLLECTIONS_SHOWN || picked.includes(n.id) || holdsPicked(n));
    const hidden = nodes.length - shown.length;
    return [
      ...shown.flatMap((n) => {
        const unfolded = searching || open.has(n.id) || holdsPicked(n);
        const on = picked.includes(n.id);
        return [
          <HStack
            key={n.id}
            gap="1"
            ps={`${depth * 14}px`}
            data-collection={n.id}
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
                onClick={() => toggle(n.id)}
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
              checked={on}
              title={displayCollection(collectionPath(byId, n.id))}
              onCheckedChange={() => search.toggle('collection', n.id)}
            >
              <Checkbox.HiddenInput />
              <Checkbox.Control />
              <Checkbox.Label flex="1" truncate textStyle="xs" color={n.total ? undefined : 'fg.muted'}>
                {n.name}
              </Checkbox.Label>
              <Text textStyle="xs" color="fg.muted" {...NUMERIC}>
                {n.total}
              </Text>
            </Checkbox.Root>
            <Menu.Root onSelect={({ value }) => act(n, value)}>
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
                  <Menu.Content minW="48">
                    <Menu.Item value="rename">
                      <Pencil /> Edit…
                    </Menu.Item>
                    <Menu.Item value="move">
                      <FolderInput /> Move into…
                    </Menu.Item>
                    <Menu.Item value="merge">
                      <Combine /> Merge into…
                    </Menu.Item>
                    <Menu.Item value="new">
                      <CornerDownRight /> New collection inside…
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
          ...(unfolded ? level(n.children, depth + 1, n.id) : []),
        ];
      }),
      ...(hidden > 0 || (more.has(parent) && !searching && nodes.length > COLLECTIONS_SHOWN)
        ? [
            <Button
              key={`more-${parent}`}
              size="2xs"
              variant="ghost"
              color="fg.muted"
              alignSelf="start"
              ms={`${depth * 14 + 20}px`}
              px="1"
              onClick={() =>
                setMore((m) => {
                  const next = new Set(m);
                  if (!next.delete(parent)) next.add(parent);
                  return next;
                })
              }
            >
              {hidden > 0 ? `Show ${hidden} more` : 'Show fewer'}
            </Button>,
          ]
        : []),
    ];
  };

  const found = filterCollectionTree(tree, query);
  return (
    <Stack gap="2">
      <TagSearch size="xs" value={query} onChange={setQuery} placeholder="Find a collection…" />
      {!searching && (
        <Checkbox.Root
          size="xs"
          ps="5"
          checked={picked.includes(NO_COLLECTION)}
          onCheckedChange={() => search.toggle('collection', NO_COLLECTION)}
        >
          <Checkbox.HiddenInput />
          <Checkbox.Control />
          <Checkbox.Label flex="1" textStyle="xs" fontStyle="italic">
            No collection
          </Checkbox.Label>
          <Text textStyle="xs" color="fg.muted" {...NUMERIC} me="5">
            {none}
          </Text>
        </Checkbox.Root>
      )}
      {found.length ? (
        <Stack gap="1">{level(found, 0, '')}</Stack>
      ) : (
        searching && (
          <Text textStyle="xs" color="fg.subtle">
            No collection matches
          </Text>
        )
      )}
      <CollectionPicker request={picker} onClose={() => setPicker(null)} />
      <ConfirmDialog
        text={confirm && { title: confirm.title, body: confirm.body }}
        confirm={confirm?.action ?? ''}
        onConfirm={() => {
          confirm?.run();
          setConfirm(null);
        }}
        onClose={() => setConfirm(null)}
      />
    </Stack>
  );
}
