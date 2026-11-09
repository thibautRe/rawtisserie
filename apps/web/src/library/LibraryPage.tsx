import {
  Box,
  Button,
  Center,
  Flex,
  HStack,
  Heading,
  Input,
  InputGroup,
  NativeSelect,
  Slider,
  Spinner,
  Stack,
  Text,
} from '@chakra-ui/react';
import { Maximize, Search, Upload } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import {
  useBatchEdit,
  useBulkUpdate,
  useDeletePhotos,
  useDuplicateVersion,
  usePhotos,
  useUpload,
} from '../api/hooks.ts';
import { COLOR_LABELS, type BulkPatch, type Photo } from '../api/types.ts';
import { AppMenu } from '../components/AppMenu.tsx';
import { DeleteVersionsDialog, describeDeletion } from '../components/DeleteVersionsDialog.tsx';
import { toaster } from '../components/toaster.tsx';
import { RAW_ACCEPT } from '../lib/format.ts';
import { FilterSidebar } from './FilterSidebar.tsx';
import { InfoPanel } from './InfoPanel.tsx';
import { type LibraryReturnState, saveLibraryView, savedLibraryView } from './libraryView.ts';
import { Loupe } from './Loupe.tsx';
import { PhotoGrid } from './PhotoGrid.tsx';
import { useLibrarySearch } from './useLibrarySearch.ts';

const SORTS = [
  { value: 'capturedDesc', label: 'Newest first' },
  { value: 'capturedAsc', label: 'Oldest first' },
  { value: 'importedDesc', label: 'Recently imported' },
  { value: 'ratingDesc', label: 'Highest rated' },
  { value: 'filename', label: 'Filename' },
];

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

export function LibraryPage() {
  const search = useLibrarySearch();
  const navigate = useNavigate();
  const query = usePhotos(search.search);
  const photos = useMemo(() => query.data?.pages.flatMap((p) => p.versions) ?? [], [query.data]);
  const total = query.data?.pages[0]?.total ?? 0;

  const location = useLocation();
  // Coming back with the filters it was left with (from the developer): restore the
  // scroll position and selection, and show the version that was being developed.
  const [restored] = useState(() => {
    const focus = (location.state as LibraryReturnState | null)?.focus ?? null;
    const view = savedLibraryView();
    const same = view?.search === search.search;
    const selection = same && (!focus || view.selection.includes(focus)) ? view.selection : focus ? [focus] : [];
    return { scrollTop: same ? view.scrollTop : 0, selection, focusedId: focus ?? (same ? view.focusedId : null) };
  });
  const [selection, setSelection] = useState<Set<string>>(() => new Set(restored.selection));
  const [focusedId, setFocusedId] = useState<string | null>(restored.focusedId);
  const anchorRef = useRef<string | null>(restored.focusedId);
  const scrollTop = useRef(restored.scrollTop);
  // Saved as it changes, not when the library unmounts: the developer's film roll reads
  // it while its route renders, before the library's cleanup would run.
  const save = () =>
    saveLibraryView({
      search: search.search,
      scrollTop: scrollTop.current,
      selection: [...selection],
      focusedId,
    });
  const latestSave = useRef(save);
  latestSave.current = save;
  useEffect(() => latestSave.current(), [search.search, selection, focusedId]);
  // The scroll position only matters when coming back: saved on the way out.
  useEffect(() => () => latestSave.current(), []);
  const gridRef = useRef<HTMLDivElement>(null);
  const [cellSize, setCellSize] = useState(() => Number(localStorage.getItem('library.cellSize')) || 200);
  const [pendingDelete, setPendingDelete] = useState<Photo[] | null>(null);
  /** The photo the culling loupe opened on, while it's open. */
  const [loupe, setLoupe] = useState<string | null>(null);
  const loupeStart = focusedId ?? [...selection][0] ?? null;

  const bulk = useBulkUpdate();
  const del = useDeletePhotos();
  const duplicate = useDuplicateVersion();
  const upload = useUpload();
  const batchEdit = useBatchEdit();

  useEffect(() => localStorage.setItem('library.cellSize', String(cellSize)), [cellSize]);

  // Drop selected photos that are no longer listed (deleted / filtered out).
  useEffect(() => {
    // Not before the first page: a restored selection would be dropped while it loads.
    if (!query.data) return;
    const listed = new Set(photos.map((p) => p.id));
    setSelection((sel) => {
      const kept = [...sel].filter((id) => listed.has(id));
      return kept.length === sel.size ? sel : new Set(kept);
    });
  }, [photos, query.data]);

  const selectedPhotos = useMemo(() => photos.filter((p) => selection.has(p.id)), [photos, selection]);

  const selectOne = useCallback((id: string) => {
    setSelection(new Set([id]));
    setFocusedId(id);
    anchorRef.current = id;
  }, []);

  const handleClick = useCallback(
    (e: React.MouseEvent, photo: Photo) => {
      if (e.shiftKey && anchorRef.current) {
        const ids = photos.map((p) => p.id);
        const [a, b] = [ids.indexOf(anchorRef.current), ids.indexOf(photo.id)].sort((x, y) => x - y);
        setSelection(new Set(ids.slice(a, b! + 1)));
        setFocusedId(photo.id);
      } else if (e.metaKey || e.ctrlKey) {
        setSelection((sel) => {
          const next = new Set(sel);
          if (next.has(photo.id)) next.delete(photo.id);
          else next.add(photo.id);
          return next;
        });
        setFocusedId(photo.id);
        anchorRef.current = photo.id;
      } else {
        selectOne(photo.id);
      }
    },
    [photos, selectOne],
  );

  const openDevelop = useCallback((photo: Photo) => navigate(`/versions/${photo.id}/develop`), [navigate]);

  /** Duplicate each selected version, then select the copies. */
  const duplicateSelection = useCallback(
    async (fromOriginal: boolean) => {
      const ids = photos.filter((p) => selection.has(p.id)).map((p) => p.id);
      if (!ids.length) return;
      try {
        const copies = await Promise.all(ids.map((id) => duplicate.mutateAsync({ id, fromOriginal })));
        setSelection(new Set(copies.map((c) => c.id)));
        setFocusedId(copies.at(-1)!.id);
        anchorRef.current = copies.at(-1)!.id;
      } catch (err) {
        toaster.create({
          type: 'error',
          title: 'Could not duplicate',
          description: err instanceof Error ? err.message : undefined,
        });
      }
    },
    [photos, selection, duplicate],
  );

  const applyToSelection = useCallback(
    (patch: BulkPatch) => {
      if (selection.size) bulk.mutate({ ids: [...selection], patch });
    },
    [bulk, selection],
  );

  // Culling shortcuts, Lightroom/darktable style.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (loupe || isTyping(e.target) || e.altKey || forOverlay.has(e)) return;
      const idx = photos.findIndex((p) => p.id === focusedId);
      const columns = Math.max(1, Math.floor((gridRef.current?.clientWidth ?? cellSize) / (cellSize + 8)));
      const move = (delta: number) => {
        const next = photos[Math.min(photos.length - 1, Math.max(0, idx < 0 ? 0 : idx + delta))];
        if (!next) return;
        if (e.shiftKey) {
          setSelection((sel) => new Set(sel).add(next.id));
          setFocusedId(next.id);
        } else selectOne(next.id);
      };
      const key = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && key === 'a') {
        e.preventDefault();
        setSelection(new Set(photos.map((p) => p.id)));
        return;
      }
      if ((e.metaKey || e.ctrlKey) && key === 'd') {
        e.preventDefault();
        void duplicateSelection(e.shiftKey);
        return;
      }
      if (e.metaKey || e.ctrlKey) return;
      if (/^[0-5]$/.test(key)) applyToSelection({ rating: Number(key) });
      else if (/^[6-9]$/.test(key)) {
        const label = COLOR_LABELS[Number(key) - 6]!;
        const all = selectedPhotos.length > 0 && selectedPhotos.every((p) => p.colorLabel === label);
        applyToSelection({ colorLabel: all ? null : label });
      } else if (key === 'p' || key === 'x') {
        // Again on photos that all have it: back to unflagged.
        const flag = key === 'p' ? 'picked' : 'rejected';
        const all = selectedPhotos.length > 0 && selectedPhotos.every((p) => p.flag === flag);
        applyToSelection({ flag: all ? null : flag });
      } else if (key === 'u') applyToSelection({ flag: null });
      else if (key === 'arrowright') move(1);
      else if (key === 'arrowleft') move(-1);
      else if (key === 'arrowdown') move(columns);
      else if (key === 'arrowup') move(-columns);
      else if ((key === 'd' || key === 'enter') && focusedId) navigate(`/versions/${focusedId}/develop`);
      else if ((key === ' ' || key === 'e') && (loupeStart ?? photos[0])) setLoupe(loupeStart ?? photos[0]!.id);
      else if ((key === 'delete' || key === 'backspace') && selection.size) setPendingDelete(selectedPhotos);
      else if (key === 'escape') setSelection(new Set());
      else return;
      e.preventDefault();
    };
    // Keys pressed in an open dialog (confirmations are alert dialogs) or menu are theirs:
    // Escape closes it and mustn't also clear the selection, Space presses its button.
    // Checked before they handle it (a menu closes on Escape at once).
    const forOverlay = new WeakSet<KeyboardEvent>();
    const claim = (e: KeyboardEvent) => {
      const overlay = '[role="dialog"], [role="alertdialog"], [role="menu"][data-state="open"]';
      if (document.querySelector(overlay)) forOverlay.add(e);
    };
    window.addEventListener('keydown', claim, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', claim, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [
    loupe,
    loupeStart,
    photos,
    focusedId,
    cellSize,
    selection,
    selectedPhotos,
    applyToSelection,
    duplicateSelection,
    selectOne,
    navigate,
  ]);

  // ── Upload (button or drag & drop) ──
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const startUpload = useCallback(
    (files: File[]) => {
      if (!files.length) return;
      const id = toaster.create({ type: 'loading', title: `Uploading ${files.length} file(s)…` });
      upload.mutate(
        {
          files,
          onProgress: (done) =>
            toaster.update(id, { type: 'loading', title: `Uploading… ${done} of ${files.length} done` }),
        },
        {
          onSuccess: ({ created, skipped }) =>
            toaster.update(id, {
              type: skipped.length ? (created.length ? 'warning' : 'error') : 'success',
              title: `Imported ${created.length} photo${created.length === 1 ? '' : 's'}`,
              description: skipped.length
                ? skipped
                    .slice(0, 5)
                    .map((s) => `${s.filename}: ${s.reason}`)
                    .join('\n') + (skipped.length > 5 ? `\n…and ${skipped.length - 5} more` : '')
                : 'Previews are being developed.',
              closable: true,
              duration: skipped.length ? 10000 : 4000,
            }),
        },
      );
    },
    [upload],
  );

  const confirmDelete = (versions: Photo[]) => {
    const { done } = describeDeletion(versions);
    del.mutate(
      versions.map((v) => v.id),
      { onSuccess: () => toaster.create({ type: 'info', title: done }) },
    );
    setPendingDelete(null);
  };

  return (
    <Flex
      h="full"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        startUpload([...e.dataTransfer.files]);
      }}
      position="relative"
    >
      <FilterSidebar search={search} />

      <Flex direction="column" flex="1" minW="0">
        <HStack px="3" py="2" borderBottomWidth="1px" gap="3">
          <AppMenu />
          <InputGroup startElement={<Search size={14} />} maxW="xs">
            <Input
              size="sm"
              placeholder="Search filename, title, tags…"
              defaultValue={search.params.get('q') ?? ''}
              onChange={(e) => search.set('q', e.target.value)}
            />
          </InputGroup>
          <NativeSelect.Root size="sm" w="44">
            <NativeSelect.Field
              value={search.params.get('sort') ?? 'capturedDesc'}
              onChange={(e) => search.set('sort', e.target.value === 'capturedDesc' ? null : e.target.value)}
            >
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
          <Text textStyle="sm" color="fg.muted" whiteSpace="nowrap">
            {selection.size ? `${selection.size} of ` : ''}
            {total} photo{total === 1 ? '' : 's'}
          </Text>
          <Box flex="1" />
          <Slider.Root
            w="28"
            size="sm"
            min={100}
            max={400}
            step={20}
            value={[cellSize]}
            onValueChange={(e) => setCellSize(e.value[0]!)}
            aria-label={['Thumbnail size']}
          >
            <Slider.Control>
              <Slider.Track>
                <Slider.Range />
              </Slider.Track>
              <Slider.Thumbs />
            </Slider.Control>
          </Slider.Root>
          <Button
            size="sm"
            variant="outline"
            disabled={!photos.length}
            onClick={() => setLoupe(loupeStart ?? photos[0]!.id)}
            title="Culling view (Space)"
          >
            <Maximize /> Cull
          </Button>
          <Button size="sm" colorPalette="orange" onClick={() => fileInput.current?.click()} loading={upload.isPending}>
            <Upload /> Import
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={RAW_ACCEPT}
            hidden
            onChange={(e) => {
              startUpload([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
        </HStack>

        {query.isPending ? (
          <Center flex="1">
            <Spinner color="orange.solid" />
          </Center>
        ) : photos.length === 0 ? (
          <Center flex="1">
            <Stack align="center" gap="3" textAlign="center" maxW="md">
              <Heading size="lg">
                {search.activeFilterCount ? 'No photos match these filters' : 'Your library is empty'}
              </Heading>
              <Text color="fg.muted">
                {search.activeFilterCount
                  ? 'Try removing some filters.'
                  : 'Drop RAW files anywhere on this page, or use Import. They are developed in the background.'}
              </Text>
              {search.activeFilterCount > 0 && (
                <Button variant="outline" onClick={search.clear}>
                  Clear filters
                </Button>
              )}
            </Stack>
          </Center>
        ) : (
          <PhotoGrid
            ref={gridRef}
            photos={photos}
            selection={selection}
            focusedId={focusedId}
            cellSize={cellSize}
            hasMore={!!query.hasNextPage}
            loadingMore={query.isFetchingNextPage}
            initialScrollTop={restored.scrollTop}
            onScroll={(top) => (scrollTop.current = top)}
            onLoadMore={() => void query.fetchNextPage()}
            onClick={handleClick}
            onOpen={openDevelop}
          />
        )}
      </Flex>

      <InfoPanel
        selected={selectedPhotos}
        onDelete={setPendingDelete}
        onDuplicate={(fromOriginal) => void duplicateSelection(fromOriginal)}
        onApplyEdit={(edit) => batchEdit([...selection], edit)}
      />

      {dragging && (
        <Center
          position="absolute"
          inset="0"
          bg="blackAlpha.700"
          borderWidth="3px"
          borderStyle="dashed"
          borderColor="orange.solid"
          pointerEvents="none"
          zIndex="overlay"
        >
          <Heading size="2xl">Drop RAW files to import them 🍗</Heading>
        </Center>
      )}

      {loupe && (
        <Loupe
          photos={photos}
          startId={loupe}
          hasMore={!!query.hasNextPage}
          onLoadMore={() => !query.isFetchingNextPage && void query.fetchNextPage()}
          onChange={(id, patch) => bulk.mutate({ ids: [id], patch })}
          onClose={(id) => {
            setLoupe(null);
            selectOne(id);
          }}
          onDevelop={(id) => navigate(`/versions/${id}/develop`)}
        />
      )}

      <DeleteVersionsDialog versions={pendingDelete} onConfirm={confirmDelete} onClose={() => setPendingDelete(null)} />
    </Flex>
  );
}
