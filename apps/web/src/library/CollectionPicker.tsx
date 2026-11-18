/**
 * Picking a collection (roadmap 8.14): where to put photos, where to move or merge a
 * collection. The tree, newest first, folded but for the way to the current one; a search
 * shows every match. A new collection can be made inside the one picked (or at the top).
 */
import { Box, Button, CloseButton, Dialog, HStack, IconButton, Input, Portal, Stack, Text } from '@chakra-ui/react';
import { ChevronDown, ChevronRight, Folder, FolderPlus, FolderX } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useCollectionChange, useCollections } from '../api/hooks.ts';
import { TagSearch } from '../components/TagSearch.tsx';
import {
  type CollectionNode,
  collectionIndex,
  collectionPath,
  collectionTree,
  displayCollection,
  filterCollectionTree,
  isWithin,
  collectionNameProblem,
  normalizeCollectionName,
} from '../lib/collections.ts';

/** What the picker offers besides the collections: "no collection" for photos, "the top" for a collection. */
export type PickerNone = { label: string; hint: string } | null;

export interface PickerRequest {
  title: string;
  /** The button doing it. */
  confirm: string;
  /** Where things are now: unfolded to, and marked. */
  current?: string | null;
  /** A collection that can't be picked, nor those under it (moving it). */
  exclude?: string;
  /** Offered first, as the null pick. */
  none: PickerNone;
  onPick: (id: string | null) => void;
}

/** Open while `request` is non-null. */
export function CollectionPicker({ request, onClose }: { request: PickerRequest | null; onClose: () => void }) {
  const shown = useRef(request);
  if (request) shown.current = request;
  const r = shown.current;
  return (
    <Dialog.Root open={!!request} onOpenChange={(e) => !e.open && onClose()} size="sm" scrollBehavior="inside">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content data-collection-picker>
            {r && <PickerBody key={r.title + (r.exclude ?? '')} request={r} onClose={onClose} />}
            <Dialog.CloseTrigger asChild>
              <CloseButton size="sm" />
            </Dialog.CloseTrigger>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function PickerBody({ request, onClose }: { request: PickerRequest; onClose: () => void }) {
  const { data: list = [] } = useCollections();
  const change = useCollectionChange();
  const tree = useMemo(() => collectionTree(list), [list]);
  const byId = useMemo(() => collectionIndex(tree), [tree]);
  // undefined: nothing picked yet; null: the "none" choice.
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<ReadonlySet<string>>(() => {
    const ids = new Set<string>();
    for (
      let c = request.current ? byId.get(request.current) : undefined;
      c;
      c = c.parentId ? byId.get(c.parentId) : undefined
    )
      if (c.id !== request.current) ids.add(c.id);
    return ids;
  });
  const [naming, setNaming] = useState('');
  const [error, setError] = useState<string | null>(null);
  const searching = query.trim() !== '';
  const blocked = (id: string) => !!request.exclude && isWithin(byId, id, request.exclude);
  const found = filterCollectionTree(tree, query);

  const toggle = (id: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const create = () => {
    const name = normalizeCollectionName(naming);
    if (!name) return;
    const problem = collectionNameProblem(name);
    if (problem) {
      setError(problem);
      return;
    }
    const parentId = picked ?? null;
    setError(null);
    change.mutate(
      { type: 'create', name, parentId },
      {
        onSuccess: (made) => {
          setNaming('');
          setQuery('');
          if (parentId) setOpen((o) => new Set(o).add(parentId));
          if (made) setPicked(made.id);
        },
        onError: (err) => setError(err.message),
      },
    );
  };

  const rows = (nodes: CollectionNode[], depth: number): React.ReactNode[] =>
    nodes.flatMap((n) => {
      const unfolded = searching || open.has(n.id);
      const disabled = blocked(n.id);
      const selected = picked === n.id;
      return [
        <HStack key={n.id} gap="1" ps={`${depth * 14}px`}>
          {n.children.length ? (
            <IconButton
              size="2xs"
              variant="ghost"
              minW="5"
              h="5"
              aria-label={unfolded ? `Fold ${n.name}` : `Unfold ${n.name}`}
              disabled={searching}
              onClick={() => toggle(n.id)}
            >
              {unfolded ? <ChevronDown /> : <ChevronRight />}
            </IconButton>
          ) : (
            <Box w="5" flexShrink={0} />
          )}
          <HStack
            as="button"
            data-pick={n.id}
            flex="1"
            minW="0"
            gap="2"
            px="2"
            py="1"
            borderRadius="sm"
            textAlign="start"
            textStyle="sm"
            aria-pressed={selected}
            aria-disabled={disabled || undefined}
            opacity={disabled ? 0.45 : 1}
            cursor={disabled ? 'not-allowed' : 'pointer'}
            bg={selected ? 'orange.subtle' : undefined}
            _hover={disabled ? undefined : { bg: selected ? 'orange.subtle' : 'bg.muted' }}
            focusRing="outside"
            onClick={() => !disabled && setPicked(n.id)}
            onDoubleClick={() => {
              if (disabled) return;
              request.onPick(n.id);
              onClose();
            }}
          >
            <Box color={selected ? 'orange.fg' : 'fg.muted'} flexShrink={0}>
              <Folder size={14} />
            </Box>
            <Text flex="1" truncate fontWeight={n.id === request.current ? 'semibold' : undefined}>
              {n.name}
            </Text>
            {n.id === request.current && (
              <Text textStyle="xs" color="fg.muted">
                current
              </Text>
            )}
            <Text textStyle="xs" color="fg.muted" fontFamily="numeric" fontVariantNumeric="tabular-nums">
              {n.total || ''}
            </Text>
          </HStack>
        </HStack>,
        ...(unfolded ? rows(n.children, depth + 1) : []),
      ];
    });

  const pickedPath = picked ? displayCollection(collectionPath(byId, picked)) : null;
  return (
    <>
      <Dialog.Header flexDirection="column" alignItems="stretch" gap="2">
        <Dialog.Title>{request.title}</Dialog.Title>
        <TagSearch size="sm" value={query} onChange={setQuery} placeholder="Find a collection…" />
      </Dialog.Header>
      <Dialog.Body>
        <Stack gap="0.5">
          {request.none && !searching && (
            <HStack
              as="button"
              data-pick="none"
              gap="2"
              px="2"
              py="1"
              ms="6"
              borderRadius="sm"
              textAlign="start"
              textStyle="sm"
              aria-pressed={picked === null}
              bg={picked === null ? 'orange.subtle' : undefined}
              _hover={{ bg: picked === null ? 'orange.subtle' : 'bg.muted' }}
              focusRing="outside"
              title={request.none.hint}
              onClick={() => setPicked(null)}
            >
              <Box color={picked === null ? 'orange.fg' : 'fg.muted'}>
                <FolderX size={14} />
              </Box>
              <Text fontStyle="italic">{request.none.label}</Text>
            </HStack>
          )}
          {found.length ? (
            rows(found, 0)
          ) : (
            <Text textStyle="sm" color="fg.subtle" px="2" py="2">
              {list.length ? 'No collection matches' : 'No collections yet: make one below'}
            </Text>
          )}
        </Stack>
      </Dialog.Body>
      <Dialog.Footer flexDirection="column" alignItems="stretch" gap="3">
        <Stack gap="1">
          <HStack
            as="form"
            gap="2"
            onSubmit={(e: React.FormEvent) => {
              e.preventDefault();
              create();
            }}
          >
            <Input
              size="sm"
              value={naming}
              maxLength={200}
              placeholder={picked ? `New collection in ${byId.get(picked)?.name ?? ''}` : 'New collection'}
              aria-label="New collection’s name"
              onChange={(e) => setNaming(e.currentTarget.value)}
            />
            <Button
              type="submit"
              size="sm"
              variant="outline"
              flexShrink={0}
              disabled={!normalizeCollectionName(naming)}
              loading={change.isPending}
            >
              <FolderPlus /> Make
            </Button>
          </HStack>
          {error && (
            <Text textStyle="xs" color="fg.error">
              {error}
            </Text>
          )}
        </Stack>
        <HStack justify="space-between" gap="3">
          <Text textStyle="xs" color="fg.muted" truncate title={pickedPath ?? undefined}>
            {picked === undefined ? 'Pick a collection' : picked === null ? request.none?.label : pickedPath}
          </Text>
          <HStack flexShrink={0}>
            <Dialog.ActionTrigger asChild>
              <Button variant="outline" size="sm">
                Cancel
              </Button>
            </Dialog.ActionTrigger>
            <Button
              colorPalette="orange"
              size="sm"
              disabled={picked === undefined || picked === request.current}
              onClick={() => {
                request.onPick(picked ?? null);
                onClose();
              }}
            >
              {request.confirm}
            </Button>
          </HStack>
        </HStack>
      </Dialog.Footer>
    </>
  );
}
