import { buttonKey, isTyping } from '../lib/keys.ts';
import { Box, Button, Center, Flex, HStack, Heading, IconButton, Spinner, Stack, Text } from '@chakra-ui/react';
import { ChevronRight, Maximize, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useDeleteForever, useRestoreFromTrash, useTrashPhotos } from '../api/hooks.ts';
import type { TrashItem } from '@rawtisserie/api';
import { AppMenu } from '../components/AppMenu.tsx';
import { toaster } from '../components/toaster.tsx';
import { DeleteForeverDialog } from '../components/trash.tsx';
import { describeDeletion, describeVersions } from '../components/trashText.ts';
import { formatBytes } from '../lib/format.ts';
import { LibraryStatusBar, SelectionBar, useColumns } from '../library/LibraryStatusBar.tsx';
import { PanelDrawer } from '../components/PanelDrawer.tsx';
import { useStableCallback } from '../develop/useStableCallback.ts';
import { useNarrow } from '../lib/useNarrow.ts';
import type { Photo } from '@rawtisserie/api';
import { Loupe } from '../library/Loupe.tsx';
import { PhotoGrid } from '../library/PhotoGrid.tsx';
import { TrashPanel } from '../library/TrashPanel.tsx';
import { useGridSelection } from '../library/useGridSelection.ts';
import { HEADER_SIZE } from '../library/SortSelect.tsx';

const failed = (title: string) => (err: Error) => toaster.create({ type: 'error', title, description: err.message });

/**
 * What the user moved to the trash, in the library's grid and side panel: select as in
 * the library, view in the loupe (without rating or developing), restore, or delete for
 * good before the server does (after `days`), to free storage now.
 */
export function TrashPage() {
  const trash = useTrashPhotos();
  const { items, total } = trash;
  const summary = trash.summary;
  const grid = useGridSelection(items);
  const { photos, selection, focusedId, focusedIndex } = grid;
  const restore = useRestoreFromTrash();
  const deleteForever = useDeleteForever();
  // Phones, as in the library: a tap views, a long press selects, the panel in a drawer.
  const narrow = useNarrow();
  const [columns, setColumns, columnRange] = useColumns(narrow);
  const [panelOpen, setPanelOpen] = useState(false);
  useEffect(() => {
    if (!selection.size) setPanelOpen(false);
  }, [selection.size]);
  /** What the confirmation is for, while it's open. */
  const [confirming, setConfirming] = useState<TrashItem[] | 'all' | null>(null);
  const [loupe, setLoupe] = useState<string | null>(null);
  const loupeStart = focusedId ?? [...selection][0] ?? null;
  // As in the library: around the photo it opened on, up to a page not in yet.
  const loupeRun = useMemo(() => {
    const at = loupe ? items.findIndex((p) => p?.id === loupe) : -1;
    if (at < 0) return { photos, start: 0, end: total };
    let [start, end] = [at, at];
    while (start > 0 && items[start - 1]) start--;
    while (end < items.length && items[end]) end++;
    return { photos: items.slice(start, end) as TrashItem[], start, end };
  }, [loupe, items, photos, total]);

  const tap = useStableCallback((_e: React.MouseEvent, photo: Photo) =>
    selection.size ? grid.toggle(photo.id) : setLoupe(photo.id),
  );
  const longPress = useCallback((photo: Photo) => grid.toggle(photo.id), [grid.toggle]);

  const onRestore = (versions: TrashItem[]) =>
    restore.mutate(
      versions.map((v) => v.id),
      {
        onSuccess: () => toaster.create({ type: 'success', title: `Restored ${describeVersions(versions)}` }),
        onError: failed('Could not restore'),
      },
    );

  const onDelete = () => {
    if (!confirming) return;
    const ids = confirming === 'all' ? 'all' : confirming.map((v) => v.id);
    setConfirming(null);
    deleteForever.mutate(ids, {
      onSuccess: ({ deleted }) =>
        toaster.create({
          type: 'info',
          title: `Deleted ${deleted.length === 1 ? '1 item' : `${deleted.length} items`}`,
        }),
      onError: failed('Could not delete'),
    });
  };

  // The library's selection keys, and Space to view; Del asks to delete for good.
  useEffect(() => {
    const buttons = new WeakSet<KeyboardEvent>();
    const onKey = (e: KeyboardEvent) => {
      if (loupe || isTyping(e.target) || e.altKey || buttons.has(e) || document.querySelector('[role="alertdialog"]'))
        return;
      const key = e.key.toLowerCase();
      const move = (delta: number) => {
        const missing = grid.step(delta, e.shiftKey);
        if (missing !== null) trash.want(missing, missing);
      };
      if ((e.metaKey || e.ctrlKey) && key === 'a') grid.selectAll();
      else if (e.metaKey || e.ctrlKey) return;
      else if (key === 'arrowright') move(1);
      else if (key === 'arrowleft') move(-1);
      else if (key === 'arrowdown') move(columns);
      else if (key === 'arrowup') move(-columns);
      else if ((key === ' ' || key === 'e') && (loupeStart ?? photos[0])) setLoupe(loupeStart ?? photos[0]!.id);
      else if ((key === 'delete' || key === 'backspace') && grid.selected.length) setConfirming(grid.selected);
      else if (key === 'escape') grid.clear();
      else return;
      e.preventDefault();
    };
    // Space or Enter on a button: the button's if the keyboard focused it, else the page's.
    const claim = (e: KeyboardEvent) => {
      if (loupe || document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"][data-state="open"]'))
        return;
      const owner = buttonKey(e);
      if (owner === 'button') buttons.add(e);
      else if (owner === 'page') onKey(e);
    };
    window.addEventListener('keydown', claim, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', claim, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [loupe, loupeStart, photos, grid, trash, columns]);

  const dialogText =
    confirming === 'all'
      ? {
          title: 'Empty the trash?',
          body:
            `Everything in the trash (${total === 1 ? '1 item' : `${total} items`}) will be deleted, ` +
            `freeing ${formatBytes(summary?.bytes ?? 0)}. This can’t be undone.`,
        }
      : confirming
        ? describeDeletion(confirming, photos)
        : null;

  return (
    <Flex h="full">
      <Flex direction="column" flex="1" minW="0">
        <HStack px="3" py="2" borderBottomWidth="1px" gap="2">
          <AppMenu />
          <HStack gap="1" color="fg.muted" textStyle="sm">
            <Link to="/settings">Settings</Link>
            <ChevronRight size={14} />
          </HStack>
          <Heading size="sm">Trash</Heading>
          <Box flex="1" />
          {!narrow && (
            <Button
              size={HEADER_SIZE}
              variant="outline"
              disabled={!photos.length}
              onClick={() => setLoupe(loupeStart ?? photos[0]!.id)}
              title="View (Space)"
            >
              <Maximize /> View
            </Button>
          )}
          {narrow ? (
            <IconButton
              size={HEADER_SIZE}
              variant="outline"
              colorPalette="red"
              aria-label="Empty trash"
              disabled={!total}
              loading={deleteForever.isPending}
              onClick={() => setConfirming('all')}
            >
              <Trash2 />
            </IconButton>
          ) : (
            <Button
              size={HEADER_SIZE}
              variant="outline"
              colorPalette="red"
              disabled={!total}
              loading={deleteForever.isPending}
              onClick={() => setConfirming('all')}
            >
              <Trash2 /> Empty trash
            </Button>
          )}
        </HStack>

        {trash.isPending ? (
          <Center flex="1">
            <Spinner color="orange.solid" />
          </Center>
        ) : total === 0 ? (
          <Center flex="1">
            <Stack align="center" gap="3" textAlign="center" maxW="md" color="fg.muted">
              <Trash2 size={32} />
              <Heading size="lg" color="fg">
                The trash is empty
              </Heading>
              <Text>
                Photos you delete from the library stay here for {summary?.days ?? 30} days, then they’re deleted for
                good.
              </Text>
            </Stack>
          </Center>
        ) : (
          <PhotoGrid
            items={items}
            selection={selection}
            focusedId={focusedId}
            focusedIndex={focusedIndex}
            columns={columns}
            onRange={trash.want}
            onClick={narrow ? tap : grid.onClick}
            onLongPress={narrow ? longPress : undefined}
          />
        )}
        {narrow && selection.size > 0 ? (
          <SelectionBar
            selected={selection.size}
            total={photos.length}
            onSelectAll={grid.selectAll}
            onDetails={() => setPanelOpen(true)}
            onDone={grid.clear}
          />
        ) : (
          <LibraryStatusBar
            selected={selection.size}
            total={total}
            developing={0}
            loading={trash.isFetching && !trash.isPending}
            columns={columns}
            range={columnRange}
            onColumnsChange={setColumns}
          />
        )}
      </Flex>

      <PanelDrawer
        narrow={narrow}
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        placement="bottom"
        title="Details"
      >
        <TrashPanel
          selected={grid.selected}
          total={total}
          bytes={summary?.bytes ?? 0}
          days={summary?.days ?? 30}
          onRestore={onRestore}
          onDelete={setConfirming}
        />
      </PanelDrawer>

      <DeleteForeverDialog
        text={dialogText}
        confirm={confirming === 'all' ? 'Empty trash' : 'Delete permanently'}
        onConfirm={onDelete}
        onClose={() => setConfirming(null)}
      />

      {loupe && (
        <Loupe
          photos={loupeRun.photos}
          startId={loupe}
          hasMore={loupeRun.end < total}
          offset={loupeRun.start}
          total={total}
          onLoadMore={() => trash.want(loupeRun.end, loupeRun.end)}
          onClose={(id) => {
            setLoupe(null);
            // On phones a selection means taps select: closing doesn't start one.
            if (!narrow) grid.selectOne(id);
          }}
        />
      )}
    </Flex>
  );
}
