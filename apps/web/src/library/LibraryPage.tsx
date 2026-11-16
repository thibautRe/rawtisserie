import { isTyping } from '../lib/keys.ts';
import {
  Box,
  Button,
  ButtonGroup,
  Center,
  Flex,
  HStack,
  Heading,
  IconButton,
  Input,
  InputGroup,
  Menu,
  NativeSelect,
  Portal,
  Spinner,
  Stack,
  Text,
} from '@chakra-ui/react';
import type { EditParams } from '@rawtisserie/pipeline';
import { ChevronDown, FolderInput, Maximize, Search, Upload } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useBatchEdit, useBulkUpdate, useDuplicateVersion, useLibraryPhotos } from '../api/hooks.ts';
import { COLOR_LABELS, type BulkPatch, type Photo } from '../api/types.ts';
import { AppMenu } from '../components/AppMenu.tsx';
import { startTransfer } from '../components/transfer.tsx';
import { useTrashWithUndo } from '../components/trash.tsx';
import { toaster } from '../components/toaster.tsx';
import { PHOTO_ACCEPT } from '../lib/format.ts';
import {
  copyEdits,
  lastSelection,
  pasteEdit,
  readClipboard,
  rememberPick,
  sourceName,
} from '../develop/editClipboard.ts';
import { CopyEditsDialog } from '../develop/presets.tsx';
import { LibraryExportDialog } from '../export/LibraryExportDialog.tsx';
import { fetchRecipe } from './batchEdit.ts';
import { FilterSidebar } from './FilterSidebar.tsx';
import { InfoPanel } from './InfoPanel.tsx';
import { type LibraryReturnState, saveLibraryView, savedLibraryView } from './libraryView.ts';
import { Loupe } from './Loupe.tsx';
import { PhotoGrid } from './PhotoGrid.tsx';
import { LibraryStatusBar, useColumns } from './LibraryStatusBar.tsx';
import { focusTagInput } from './TagCompletion.tsx';
import { useGridSelection } from './useGridSelection.ts';
import { useImporter } from './useImporter.tsx';
import { useTagShortcuts } from './useTagShortcuts.tsx';
import { displayTag } from '../lib/tags.ts';
import { fromDrop, fromDropHandles, fromInput, keepsHandles, pickFiles, pickFolder } from './pickedFiles.ts';
import { useLibrarySearch } from './useLibrarySearch.ts';

const SORTS = [
  { value: 'capturedDesc', label: 'Newest first' },
  { value: 'capturedAsc', label: 'Oldest first' },
  { value: 'importedDesc', label: 'Recently imported' },
  { value: 'ratingDesc', label: 'Highest rated' },
  { value: 'filename', label: 'Filename' },
];

export function LibraryPage() {
  const search = useLibrarySearch();
  const navigate = useNavigate();
  const library = useLibraryPhotos(search.search);
  const { items, total } = library;

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
  const grid = useGridSelection(items, restored);
  const { photos, selection, focusedId, focusedIndex, selectOne } = grid;
  const selectedPhotos = grid.selected;
  const scrollTop = useRef(restored.scrollTop);
  // Saved as it changes, not when the library unmounts: the developer's film roll reads
  // it while its route renders, before the library's cleanup would run.
  const save = () =>
    saveLibraryView({
      search: search.search,
      scrollTop: scrollTop.current,
      selection: [...selection],
      focusedId,
      focusedIndex,
    });
  const latestSave = useRef(save);
  latestSave.current = save;
  useEffect(() => latestSave.current(), [search.search, selection, focusedId]);
  // The scroll position only matters when coming back: saved on the way out.
  useEffect(() => () => latestSave.current(), []);
  const [columns, setColumns] = useColumns();
  /** The photo the culling loupe opened on, while it's open. */
  const [loupe, setLoupe] = useState<string | null>(null);
  const loupeStart = focusedId ?? [...selection][0] ?? null;
  // The loupe goes through the photos in, around the one it opened on (up to a page not
  // in yet, which it asks for as it gets there).
  const loupeRun = useMemo(() => {
    const at = loupe ? items.findIndex((p) => p?.id === loupe) : -1;
    if (at < 0) return { photos, start: 0, end: total };
    let [start, end] = [at, at];
    while (start > 0 && items[start - 1]) start--;
    while (end < items.length && items[end]) end++;
    return { photos: items.slice(start, end) as Photo[], start, end };
  }, [loupe, items, photos, total]);

  const bulk = useBulkUpdate();
  const moveToTrash = useTrashWithUndo();
  const duplicate = useDuplicateVersion();
  const { start: startImport, review: importReview } = useImporter();
  /**
   * Pick files or a folder: with the browser's own pickers where they keep what was
   * picked (an import then survives a reload), else with the inputs below.
   */
  const importFrom = (kind: 'files' | 'folder') => {
    if (!keepsHandles()) return (kind === 'files' ? fileInput : folderInput).current?.click();
    void (kind === 'files' ? pickFiles() : pickFolder())
      .then((picked) => picked && startImport(picked.files, picked.from, picked.listing))
      .catch((err: Error) => toaster.create({ type: 'error', title: 'Could not open that', description: err.message }));
  };
  const importIds = search.params.getAll('import');
  const batchEdit = useBatchEdit();

  const openDevelop = useCallback((photo: Photo) => navigate(`/versions/${photo.id}/develop`), [navigate]);

  /** Duplicate each selected version, then select the copies. */
  const duplicateSelection = useCallback(
    async (fromOriginal: boolean) => {
      const ids = photos.filter((p) => selection.has(p.id)).map((p) => p.id);
      if (!ids.length) return;
      try {
        const copies = await Promise.all(ids.map((id) => duplicate.mutateAsync({ id, fromOriginal })));
        grid.selectMany(copies.map((c) => c.id));
      } catch (err) {
        toaster.create({
          type: 'error',
          title: 'Could not duplicate',
          description: err instanceof Error ? err.message : undefined,
        });
      }
    },
    [photos, selection, duplicate, grid.selectMany],
  );

  // ── Export (roadmap 8.4): the selection, in the grid's order ──
  const [exporting, setExporting] = useState<Photo[] | null>(null);
  /** The frame preview shows the focused photo if it's exported, or the first one. */
  const exportPreview = exporting && (exporting.find((p) => p.id === focusedId) ?? exporting[0] ?? null);

  // ── Copy and paste settings (roadmap 8.6) ──
  const [copyDialog, setCopyDialog] = useState<{ recipe: EditParams; source: string } | null>(null);
  /** The photo to copy from: the focused one if it's selected, or the only one selected. */
  const copySource = () => {
    const id = focusedId && selection.has(focusedId) ? focusedId : selection.size === 1 ? [...selection][0]! : null;
    return photos.find((p) => p.id === id) ?? null;
  };
  /** Copy what was picked last time from the selected photo, or (`pick`) open the dialog. */
  const copyFrom = async (pick: boolean) => {
    const photo = copySource();
    if (!photo) return;
    try {
      const recipe = await fetchRecipe(photo.id);
      if (!recipe) {
        toaster.create({ type: 'warning', title: `${photo.filename} is still being imported`, duration: 4000 });
        return;
      }
      const source = sourceName(photo.filename);
      if (pick) return setCopyDialog({ recipe, source });
      const n = copyEdits(recipe, lastSelection(recipe), source);
      toaster.create({
        type: 'info',
        title: `Copied ${n === 1 ? '1 module' : `${n} modules`} from ${source}`,
        duration: 2500,
      });
    } catch (err) {
      toaster.create({
        type: 'error',
        title: 'Could not copy',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };
  const pasteToSelection = (appendAll: boolean) => {
    const clip = readClipboard();
    if (!clip)
      toaster.create({
        type: 'info',
        title: 'Nothing copied yet',
        description: 'Copy settings with Ctrl+C',
        duration: 2500,
      });
    else void batchEdit([...selection], pasteEdit(clip, appendAll));
  };
  const latestCopy = useRef({ copyFrom, pasteToSelection });
  latestCopy.current = { copyFrom, pasteToSelection };

  const applyToSelection = useCallback(
    (patch: BulkPatch) => {
      if (selection.size) bulk.mutate({ ids: [...selection], patch });
    },
    [bulk, selection],
  );

  // The tags' shortcuts (tag manager) toggle a tag on the selection, as P does a flag.
  const toggleTag = (tag: string) => {
    if (!selectedPhotos.length) {
      toaster.create({ type: 'info', title: 'Select photos to tag first', duration: 2000 });
      return;
    }
    const all = selectedPhotos.every((p) => p.tags.includes(tag));
    applyToSelection(all ? { removeTags: [tag] } : { addTags: [tag] });
    const n = selectedPhotos.length === 1 ? '1 photo' : `${selectedPhotos.length} photos`;
    toaster.create({
      type: 'success',
      title: all ? `Removed ${displayTag(tag)} from ${n}` : `Tagged ${n} ${displayTag(tag)}`,
      duration: 2000,
    });
  };
  const tagSequence = useTagShortcuts(loupe ? null : toggleTag);

  // Culling shortcuts, Lightroom/darktable style.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (loupe || isTyping(e.target) || e.altKey || forOverlay.has(e)) return;
      const move = (delta: number) => {
        const missing = grid.step(delta, e.shiftKey);
        // Not in yet: the grid scrolls there, and the page is asked for.
        if (missing !== null) library.want(missing, missing);
      };
      const key = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && key === 'a') {
        e.preventDefault();
        grid.selectAll();
        return;
      }
      // Copy and paste settings, unless there's text selected to copy.
      if ((e.metaKey || e.ctrlKey) && key === 'c' && !window.getSelection()?.toString()) {
        e.preventDefault();
        void latestCopy.current.copyFrom(e.shiftKey);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && key === 'v' && selection.size) {
        e.preventDefault();
        latestCopy.current.pasteToSelection(e.shiftKey);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && key === 'e') {
        e.preventDefault();
        if (selection.size) setExporting(selectedPhotos);
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
      else if (key === 't') {
        if (!focusTagInput()) return;
      } else if (key === 'arrowright') move(1);
      else if (key === 'arrowleft') move(-1);
      else if (key === 'arrowdown') move(columns);
      else if (key === 'arrowup') move(-columns);
      else if ((key === 'd' || key === 'enter') && focusedId) navigate(`/versions/${focusedId}/develop`);
      else if ((key === ' ' || key === 'e') && (loupeStart ?? photos[0])) setLoupe(loupeStart ?? photos[0]!.id);
      else if ((key === 'delete' || key === 'backspace') && selection.size) trash(selectedPhotos);
      else if (key === 'escape') grid.clear();
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
    library,
    focusedId,
    columns,
    grid,
    selection,
    selectedPhotos,
    applyToSelection,
    duplicateSelection,
    navigate,
  ]);

  // ── Import (button or drag & drop) ──
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);

  const trash = (versions: Photo[]) =>
    void moveToTrash(versions).catch((err: Error) =>
      toaster.create({ type: 'error', title: 'Could not move to the trash', description: err.message }),
    );

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
        // Taken now: the drop's items are gone after the event.
        // With handles where the browser gives them, so the import survives a reload.
        const withHandles = fromDropHandles(e.dataTransfer);
        const listing = { found: 0 };
        void (withHandles
          ? startImport(withHandles.files, withHandles.from, withHandles.listing)
          : startImport(fromDrop(e.dataTransfer, listing), undefined, listing));
      }}
      position="relative"
    >
      {importReview}
      {tagSequence}
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
          <Box flex="1" />
          <Button
            size="sm"
            variant="outline"
            disabled={!photos.length}
            onClick={() => setLoupe(loupeStart ?? photos[0]!.id)}
            title="Culling view (Space)"
          >
            <Maximize /> Cull
          </Button>
          <ButtonGroup size="sm" colorPalette="orange" attached>
            <Button onClick={() => importFrom('files')} title="Import RAW files">
              <Upload /> Import
            </Button>
            <Menu.Root positioning={{ placement: 'bottom-end' }}>
              <Menu.Trigger asChild>
                <IconButton aria-label="More ways to import" borderStartWidth="1px" borderColor="orange.emphasized">
                  <ChevronDown />
                </IconButton>
              </Menu.Trigger>
              <Portal>
                <Menu.Positioner>
                  <Menu.Content>
                    <Menu.Item value="files" onSelect={() => importFrom('files')}>
                      <Upload /> Files…
                    </Menu.Item>
                    <Menu.Item value="folder" onSelect={() => importFrom('folder')}>
                      <FolderInput /> Folder or card…
                    </Menu.Item>
                  </Menu.Content>
                </Menu.Positioner>
              </Portal>
            </Menu.Root>
          </ButtonGroup>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={PHOTO_ACCEPT}
            hidden
            onChange={(e) => {
              void startImport(fromInput(e.target.files ?? []));
              e.target.value = '';
            }}
          />
          <input
            // Not a React prop: set on the element.
            ref={(el) => {
              folderInput.current = el;
              el?.setAttribute('webkitdirectory', '');
            }}
            type="file"
            hidden
            onChange={(e) => {
              void startImport(fromInput(e.target.files ?? []));
              e.target.value = '';
            }}
          />
        </HStack>

        {library.isPending ? (
          <Center flex="1">
            <Spinner color="orange.solid" />
          </Center>
        ) : total === 0 && importIds.length > 0 && search.activeFilterCount === 1 ? (
          <Center flex="1">
            <Stack align="center" gap="3" textAlign="center" maxW="md">
              <Heading size="lg">Nothing new from {importIds.length > 1 ? 'these imports' : 'this import'}</Heading>
              <Text color="fg.muted">
                {importIds.length > 1 ? 'Their' : 'Its'} files were already in your library, or couldn’t be imported.
              </Text>
              <Button variant="outline" onClick={search.clear}>
                Clear filters
              </Button>
            </Stack>
          </Center>
        ) : total === 0 ? (
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
            items={items}
            selection={selection}
            focusedId={focusedId}
            focusedIndex={focusedIndex}
            columns={columns}
            onRange={library.want}
            initialScrollTop={restored.scrollTop}
            onScroll={(top) => (scrollTop.current = top)}
            onClick={grid.onClick}
            onOpen={openDevelop}
          />
        )}
        <LibraryStatusBar
          selected={selection.size}
          total={total}
          developing={photos.filter((p) => p.renderStatus === 'pending').length}
          loading={library.isFetching && !library.isPending}
          columns={columns}
          onColumnsChange={setColumns}
        />
      </Flex>

      <InfoPanel
        selected={selectedPhotos}
        onDelete={trash}
        onDuplicate={(fromOriginal) => void duplicateSelection(fromOriginal)}
        onApplyEdit={(edit) => batchEdit([...selection], edit)}
        onCopy={() => void copyFrom(true)}
        onExport={() => setExporting(selectedPhotos)}
        onSend={(instance) => void startTransfer(instance, { ids: selectedPhotos.map((p) => p.id) })}
      />
      <LibraryExportDialog photos={exporting} preview={exportPreview} onClose={() => setExporting(null)} />
      {copyDialog && (
        <CopyEditsDialog
          recipe={copyDialog.recipe}
          initial={lastSelection(copyDialog.recipe)}
          onClose={() => setCopyDialog(null)}
          onCopy={(selection) => {
            rememberPick(copyDialog.recipe, selection);
            const n = copyEdits(copyDialog.recipe, selection, copyDialog.source);
            toaster.create({
              type: 'info',
              title: `Copied ${n === 1 ? '1 module' : `${n} modules`} from ${copyDialog.source}`,
              duration: 2500,
            });
          }}
        />
      )}

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
          photos={loupeRun.photos}
          startId={loupe}
          hasMore={loupeRun.end < total}
          offset={loupeRun.start}
          total={total}
          onLoadMore={() => library.want(loupeRun.end, loupeRun.end)}
          onChange={(id, patch) => bulk.mutate({ ids: [id], patch })}
          onClose={(id) => {
            setLoupe(null);
            selectOne(id);
          }}
          onDevelop={(id) => navigate(`/versions/${id}/develop`)}
        />
      )}
    </Flex>
  );
}
