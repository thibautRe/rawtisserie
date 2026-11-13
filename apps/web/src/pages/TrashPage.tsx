import {
  Box,
  Button,
  Center,
  Checkbox,
  Flex,
  HStack,
  Heading,
  Image,
  SimpleGrid,
  Spinner,
  Text,
} from '@chakra-ui/react';
import { ImageOff, RotateCcw, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useDeleteForever, useRestoreFromTrash, useTrash } from '../api/hooks.ts';
import type { TrashItem } from '../api/types.ts';
import { AppMenu } from '../components/AppMenu.tsx';
import { toaster } from '../components/toaster.tsx';
import { DeleteForeverDialog } from '../components/trash.tsx';
import { deletedIn, describeDeletion, describeVersions } from '../components/trashText.ts';
import { formatBytes, versionLabel } from '../lib/format.ts';

const failed = (title: string) => (err: Error) => toaster.create({ type: 'error', title, description: err.message });

/**
 * What the user moved to the trash: restore it, or delete it for good before the server
 * does (after `days`), to free storage now.
 */
export function TrashPage() {
  const trash = useTrash();
  const restore = useRestoreFromTrash();
  const deleteForever = useDeleteForever();
  const items = useMemo(() => trash.data?.pages.flatMap((p) => p.versions) ?? [], [trash.data]);
  const summary = trash.data?.pages.at(-1);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState<'selection' | 'all' | null>(null);
  // Only what's still listed.
  const selection = items.filter((v) => selected.has(v.id));

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const onRestore = () =>
    restore.mutate(
      selection.map((v) => v.id),
      {
        onSuccess: () => {
          toaster.create({ type: 'success', title: `Restored ${describeVersions(selection)}` });
          setSelected(new Set());
        },
        onError: failed('Could not restore'),
      },
    );

  const onDelete = () => {
    const ids = confirming === 'all' ? 'all' : selection.map((v) => v.id);
    setConfirming(null);
    deleteForever.mutate(ids, {
      onSuccess: ({ deleted }) => {
        toaster.create({
          type: 'info',
          title: `Deleted ${deleted.length === 1 ? '1 item' : `${deleted.length} items`}`,
        });
        setSelected(new Set());
      },
      onError: failed('Could not delete'),
    });
  };

  const dialogText =
    confirming === 'all'
      ? {
          title: 'Empty the trash?',
          body:
            `Everything in the trash (${summary?.total ?? 0} items) will be deleted, ` +
            `freeing ${formatBytes(summary?.bytes ?? 0)}. This can’t be undone.`,
        }
      : confirming === 'selection'
        ? describeDeletion(selection, items)
        : null;

  return (
    <Flex direction="column" h="full">
      <HStack px="3" py="2" gap="2" borderBottomWidth="1px">
        <AppMenu />
        <Heading size="sm">Trash</Heading>
        <Box flex="1" />
        {selection.length > 0 && (
          <>
            <Button size="xs" variant="outline" loading={restore.isPending} onClick={onRestore}>
              <RotateCcw /> Restore {selection.length}
            </Button>
            <Button
              size="xs"
              variant="outline"
              colorPalette="red"
              loading={deleteForever.isPending && confirming === null}
              onClick={() => setConfirming('selection')}
            >
              <Trash2 /> Delete {selection.length} permanently
            </Button>
          </>
        )}
        {items.length > 0 && (
          <Button size="xs" variant="ghost" colorPalette="red" onClick={() => setConfirming('all')}>
            Empty trash
          </Button>
        )}
      </HStack>

      <Box flex="1" overflowY="auto">
        <Box p="6" maxW="6xl" mx="auto">
          {trash.isPending ? (
            <Center py="16">
              <Spinner />
            </Center>
          ) : trash.isError ? (
            <Text color="fg.error">Could not load the trash: {trash.error.message}</Text>
          ) : !items.length ? (
            <Center py="16" flexDirection="column" gap="2" color="fg.muted">
              <Trash2 size={32} />
              <Text>The trash is empty.</Text>
              <Text textStyle="sm">
                Photos you delete from the library stay here for {summary?.days ?? 30} days, then they’re deleted for
                good.
              </Text>
            </Center>
          ) : (
            <>
              <HStack justify="space-between" mb="4" gap="4" wrap="wrap">
                <Checkbox.Root
                  size="sm"
                  checked={selection.length === items.length ? true : selection.length ? 'indeterminate' : false}
                  onCheckedChange={(e) => setSelected(new Set(e.checked === true ? items.map((v) => v.id) : []))}
                >
                  <Checkbox.HiddenInput />
                  <Checkbox.Control />
                  <Checkbox.Label>
                    {selection.length ? `${selection.length} of ${summary!.total} selected` : 'Select all'}
                  </Checkbox.Label>
                </Checkbox.Root>
                <Text textStyle="sm" color="fg.muted">
                  Items are deleted for good {summary!.days} days after they’re moved here. Until then, their original
                  files count towards your storage ({formatBytes(summary!.bytes)}).
                </Text>
              </HStack>
              <SimpleGrid templateColumns="repeat(auto-fill, minmax(11rem, 1fr))" gap="3">
                {items.map((v) => (
                  <TrashCard key={v.id} item={v} selected={selected.has(v.id)} onToggle={() => toggle(v.id)} />
                ))}
              </SimpleGrid>
              {trash.hasNextPage && (
                <Center mt="4">
                  <Button
                    size="sm"
                    variant="outline"
                    loading={trash.isFetchingNextPage}
                    onClick={() => void trash.fetchNextPage()}
                  >
                    Show more
                  </Button>
                </Center>
              )}
            </>
          )}
        </Box>
      </Box>

      <DeleteForeverDialog
        text={dialogText}
        confirm={confirming === 'all' ? 'Empty trash' : 'Delete permanently'}
        onConfirm={onDelete}
        onClose={() => setConfirming(null)}
      />
    </Flex>
  );
}

function TrashCard({ item, selected, onToggle }: { item: TrashItem; selected: boolean; onToggle: () => void }) {
  const named = item.versionName !== null || item.versionCount > 1;
  return (
    <Box
      as="button"
      textAlign="start"
      onClick={onToggle}
      aria-pressed={selected}
      borderRadius="md"
      borderWidth="2px"
      borderColor={selected ? 'orange.solid' : 'transparent'}
      p="1"
      focusRing="outside"
    >
      <Box position="relative" aspectRatio="3 / 2" bg="bg.muted" borderRadius="sm" overflow="hidden">
        {item.thumbUrl ? (
          <Image src={item.thumbUrl} alt="" w="full" h="full" objectFit="contain" loading="lazy" />
        ) : (
          <Center h="full" color="fg.subtle">
            <ImageOff size={20} />
          </Center>
        )}
        <Checkbox.Root
          size="sm"
          checked={selected}
          position="absolute"
          top="1.5"
          left="1.5"
          pointerEvents="none"
          aria-hidden
        >
          <Checkbox.Control bg={selected ? undefined : 'bg/70'} />
        </Checkbox.Root>
      </Box>
      <Box px="1" pt="1.5" pb="1">
        <Text textStyle="sm" truncate>
          {item.filename}
          {named && (
            <Text as="span" color="fg.muted">
              {' · '}
              {versionLabel({ name: item.versionName, index: item.versionIndex })}
            </Text>
          )}
        </Text>
        <Text textStyle="xs" color="fg.muted">
          Deleted {deletedIn(item.deleteAt)}
        </Text>
      </Box>
    </Box>
  );
}
