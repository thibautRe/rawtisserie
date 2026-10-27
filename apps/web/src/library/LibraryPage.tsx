import {
  Box,
  Button,
  Center,
  CloseButton,
  Dialog,
  Flex,
  HStack,
  Heading,
  Input,
  InputGroup,
  NativeSelect,
  Portal,
  Slider,
  Spinner,
  Stack,
  Text,
} from '@chakra-ui/react';
import { Search, Upload } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useBulkUpdate, useDeletePhotos, usePhotos, useUpload } from '../api/hooks.ts';
import { COLOR_LABELS, type BulkPatch, type Photo } from '../api/types.ts';
import { AppMenu } from '../components/AppMenu.tsx';
import { toaster } from '../components/toaster.tsx';
import { RAW_ACCEPT } from '../lib/format.ts';
import { FilterSidebar } from './FilterSidebar.tsx';
import { InfoPanel } from './InfoPanel.tsx';
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
  target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

export function LibraryPage() {
  const search = useLibrarySearch();
  const navigate = useNavigate();
  const query = usePhotos(search.search);
  const photos = useMemo(() => query.data?.pages.flatMap((p) => p.versions) ?? [], [query.data]);
  const total = query.data?.pages[0]?.total ?? 0;

  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const anchorRef = useRef<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [cellSize, setCellSize] = useState(() => Number(localStorage.getItem('library.cellSize')) || 200);
  const [pendingDelete, setPendingDelete] = useState<string[] | null>(null);

  const bulk = useBulkUpdate();
  const del = useDeletePhotos();
  const upload = useUpload();

  useEffect(() => localStorage.setItem('library.cellSize', String(cellSize)), [cellSize]);

  // Drop selected photos that are no longer listed (deleted / filtered out).
  useEffect(() => {
    const listed = new Set(photos.map((p) => p.id));
    setSelection((sel) => {
      const kept = [...sel].filter((id) => listed.has(id));
      return kept.length === sel.size ? sel : new Set(kept);
    });
  }, [photos]);

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

  const applyToSelection = useCallback(
    (patch: BulkPatch) => {
      if (selection.size) bulk.mutate({ ids: [...selection], patch });
    },
    [bulk, selection],
  );

  // Culling shortcuts, Lightroom/darktable style.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.altKey || document.querySelector('[role="dialog"]')) return;
      const idx = photos.findIndex((p) => p.id === focusedId);
      const columns = Math.max(1, Math.floor((gridRef.current?.clientWidth ?? cellSize) / (cellSize + 8)));
      const move = (delta: number) => {
        const next = photos[Math.min(photos.length - 1, Math.max(0, (idx < 0 ? 0 : idx + delta)))];
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
      if (e.metaKey || e.ctrlKey) return;
      if (/^[0-5]$/.test(key)) applyToSelection({ rating: Number(key) });
      else if (/^[6-9]$/.test(key)) {
        const label = COLOR_LABELS[Number(key) - 6]!;
        const all = selectedPhotos.length > 0 && selectedPhotos.every((p) => p.colorLabel === label);
        applyToSelection({ colorLabel: all ? null : label });
      } else if (key === 'p') applyToSelection({ flag: 'picked' });
      else if (key === 'x') applyToSelection({ flag: 'rejected' });
      else if (key === 'u') applyToSelection({ flag: null });
      else if (key === 'arrowright') move(1);
      else if (key === 'arrowleft') move(-1);
      else if (key === 'arrowdown') move(columns);
      else if (key === 'arrowup') move(-columns);
      else if ((key === 'd' || key === 'enter') && focusedId) navigate(`/versions/${focusedId}/develop`);
      else if ((key === 'delete' || key === 'backspace') && selection.size) setPendingDelete([...selection]);
      else if (key === 'escape') setSelection(new Set());
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [photos, focusedId, cellSize, selection, selectedPhotos, applyToSelection, selectOne, navigate]);

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
          onProgress: (done) => toaster.update(id, { type: 'loading', title: `Uploading… ${done} of ${files.length} done` }),
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

  const confirmDelete = () => {
    if (!pendingDelete) return;
    del.mutate(pendingDelete, {
      onSuccess: ({ deleted }) => toaster.create({ type: 'info', title: `Deleted ${deleted.length} photo(s)` }),
    });
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
              <Heading size="lg">{search.activeFilterCount ? 'No photos match these filters' : 'Your library is empty'}</Heading>
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
            onLoadMore={() => void query.fetchNextPage()}
            onClick={handleClick}
            onOpen={openDevelop}
          />
        )}
      </Flex>

      <InfoPanel selected={selectedPhotos} onDelete={setPendingDelete} />

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

      <Dialog.Root open={!!pendingDelete} onOpenChange={(e) => !e.open && setPendingDelete(null)} role="alertdialog">
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content>
              <Dialog.Header>
                <Dialog.Title>
                  Delete {pendingDelete?.length} photo{pendingDelete?.length === 1 ? '' : 's'}?
                </Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <Text>The original RAW files, edits and metadata will be permanently removed.</Text>
              </Dialog.Body>
              <Dialog.Footer>
                <Dialog.ActionTrigger asChild>
                  <Button variant="outline">Cancel</Button>
                </Dialog.ActionTrigger>
                <Button colorPalette="red" onClick={confirmDelete} autoFocus>
                  Delete
                </Button>
              </Dialog.Footer>
              <Dialog.CloseTrigger asChild>
                <CloseButton size="sm" />
              </Dialog.CloseTrigger>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </Flex>
  );
}
