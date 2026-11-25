import { buttonKey, commandLabel, isTyping } from '../lib/keys.ts';
import {
  Badge,
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
  Portal,
  Spinner,
  Stack,
  Text,
} from '@chakra-ui/react';
import type { EditParams } from '@rawtisserie/pipeline';
import { ChevronDown, Filter, FolderInput, ListRestart, Maximize, Search, Upload } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import {
  fetchTargetIds,
  fetchTargetPhotos,
  useBatchEdit,
  useBulkUpdate,
  useCollections,
  useDuplicateVersion,
  useLibraryPhotos,
  useMoveToCollection,
  keepListed,
  useApplyFilters,
} from '../api/hooks.ts';
import { collectionPath, displayCollection } from '../lib/collections.ts';
import { CollectionPicker, type PickerRequest } from './CollectionPicker.tsx';
import { COLOR_LABELS, type BulkPatch, type Photo, type RemoteInstance } from '@rawtisserie/api';
import { AppMenu } from '../components/AppMenu.tsx';
import { PanelDrawer } from '../components/PanelDrawer.tsx';
import { hostOf, startTransfer } from '../components/transfer.tsx';
import { useTrashWithUndo } from '../components/trash.tsx';
import { toaster } from '../components/toaster.tsx';
import { IMPORT_ACCEPT } from '../lib/format.ts';
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
import { type BatchEdit, fetchRecipe } from './batchEdit.ts';
import { patchQuestion, photoCount } from './selectionText.ts';
import { useConfirmLarge } from './useConfirmLarge.tsx';
import { FilterSidebar } from './FilterSidebar.tsx';
import { SortSelect } from './SortSelect.tsx';
import { HEADER_SIZE } from '../lib/headerSize.ts';
import { InfoPanel } from './InfoPanel.tsx';
import { type LibraryReturnState, saveLibraryView, savedLibraryView } from './libraryView.ts';
import { Loupe } from './Loupe.tsx';
import { PhotoGrid } from './PhotoGrid.tsx';
import { LibraryStatusBar, SelectionBar, useColumns } from './LibraryStatusBar.tsx';
import { focusTagInput } from './TagCompletion.tsx';
import { useGridSelection } from './useGridSelection.ts';
import { useImporter } from './useImporter.tsx';
import { useTagShortcuts } from './useTagShortcuts.tsx';
import { displayTag } from '../lib/tags.ts';
import { fromDrop, fromDropHandles, fromInput, keepsHandles, pickFiles, pickFolder } from './pickedFiles.ts';
import { useLibrarySearch } from './useLibrarySearch.ts';
import { useNarrow } from '../lib/useNarrow.ts';
import { useStableCallback } from '../develop/useStableCallback.ts';

export function LibraryPage() {
  const search = useLibrarySearch();
  // Phones (roadmap 10.1): the filters and the info panel in drawers, a tap opens the
  // loupe (a long press selects), and no developer (10.2).
  const narrow = useNarrow();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const navigate = useNavigate();
  const library = useLibraryPhotos(search.search);
  const { items, total } = library;
  // Photos changed here stay listed, as in the loupe, until the filters are applied again.
  const keep = (ids: readonly string[]) => keepListed(search.search, ids);
  const applyFilters = useApplyFilters();
  const qc = useQueryClient();
  /** How many photos listed no longer match the filters. */
  const outside = library.latest?.outside ?? 0;

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
  // Select all (Ctrl+A) selects every photo the filters match (roadmap 8.13).
  const grid = useGridSelection(items, restored, { scope: search.search, total });
  const [ask, askDialog] = useConfirmLarge();
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
  const [columns, setColumns, columnRange] = useColumns(narrow);
  useEffect(() => {
    if (!grid.count) setInfoOpen(false);
  }, [grid.count]);
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
  const moveToCollection = useMoveToCollection();
  const { data: collections = [] } = useCollections();
  // Read when a pick is made: the picker may have made a collection since it opened.
  const latestCollections = useRef(collections);
  latestCollections.current = collections;
  const [collectionPicker, setCollectionPicker] = useState<PickerRequest | null>(null);
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
  // Phones: a tap opens the loupe, or while photos are selected adds or removes one.
  const tap = useStableCallback((_e: React.MouseEvent, photo: Photo) =>
    grid.count ? grid.toggle(photo.id) : setLoupe(photo.id),
  );
  const longPress = useCallback((photo: Photo) => grid.toggle(photo.id), [grid.toggle]);

  /** The selection's ids, in the library's order: asked to the server for a selection by filter. */
  const selectionIds = async () => {
    const target = grid.target();
    if ('ids' in target) return photos.filter((p) => selection.has(p.id)).map((p) => p.id);
    return fetchTargetIds(target);
  };
  const failed = (title: string) => (err: unknown) =>
    toaster.create({ type: 'error', title, description: err instanceof Error ? err.message : undefined });

  /** Duplicate each selected version, then select the copies. */
  const duplicateSelection = (fromOriginal: boolean) => {
    if (!grid.count) return;
    ask(
      grid.count,
      { title: `Duplicate ${photoCount(grid.count)}?`, confirm: 'Duplicate' },
      () =>
        void selectionIds()
          .then((ids) => Promise.all(ids.map((id) => duplicate.mutateAsync({ id, fromOriginal }))))
          .then((copies) => {
            // Listed even if the filters wouldn't (a copy from the original isn't edited).
            keep(copies.map((c) => c.id));
            void qc.invalidateQueries({ queryKey: ['photos', search.search] });
            grid.selectMany(copies.map((c) => c.id));
          })
          .catch(failed('Could not duplicate')),
    );
  };

  /** Apply a preset, a style or pasted settings to the selection, one photo at a time. */
  const editSelection = (edit: BatchEdit) => {
    if (!grid.count) return;
    ask(
      grid.count,
      { title: `${edit.label}: ${photoCount(grid.count)}?`, confirm: 'Apply' },
      () =>
        void selectionIds()
          .then((ids) => {
            keep(ids);
            return batchEdit(ids, edit);
          })
          .catch(failed('Could not edit')),
    );
  };

  /** Export the selection (all the photos a selection by filter holds, asked to the server). */
  const exportSelection = () => {
    if (!grid.count) return;
    const target = grid.target();
    ask(grid.count, { title: `Export ${photoCount(grid.count)}?`, confirm: 'Export' }, () =>
      'ids' in target
        ? setExporting(selectedPhotos)
        : void fetchTargetPhotos(target).then(setExporting).catch(failed('Could not list the photos')),
    );
  };

  const sendSelection = (instance: RemoteInstance) => {
    if (!grid.count) return;
    ask(
      grid.count,
      { title: `Send ${photoCount(grid.count)} to ${hostOf(instance.url)}?`, confirm: 'Send' },
      () => void startTransfer(instance, grid.target()),
    );
  };

  /** Put the selection's photos in a collection, picked in a dialog. */
  const moveSelectionToCollection = (current: string | null) => {
    if (!grid.count) return;
    const target = grid.target();
    const count = grid.count;
    setCollectionPicker({
      title: `Move ${photoCount(count)} to…`,
      confirm: 'Move',
      current,
      none: { label: 'No collection', hint: 'Out of every collection' },
      onPick: (collectionId) => {
        const name = collectionId
          ? displayCollection(collectionPath(new Map(latestCollections.current.map((c) => [c.id, c])), collectionId))
          : null;
        ask(
          count,
          { title: `Move ${photoCount(count)} to ${name ?? 'no collection'}?`, confirm: 'Move' },
          () => (
            keep(selectedPhotos.map((p) => p.id)),
            moveToCollection.mutate(
              { target, collectionId },
              {
                onSuccess: (moved) =>
                  toaster.create({
                    type: 'info',
                    title: name
                      ? `Moved ${photoCount(moved)} to ${name}`
                      : `${photoCount(moved)} out of their collection`,
                    duration: 3000,
                  }),
                onError: failed('Could not move them'),
              },
            )
          ),
        );
      },
    });
  };

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
        description: `Copy settings with ${commandLabel('Ctrl+C')}`,
        duration: 2500,
      });
    else editSelection(pasteEdit(clip, appendAll));
  };
  /** Paste onto one photo (the loupe's). */
  const pasteTo = (id: string, appendAll: boolean) => {
    const clip = readClipboard();
    if (!clip) toaster.create({ type: 'info', title: 'Nothing copied yet', duration: 2500 });
    else {
      keep([id]);
      void batchEdit([id], pasteEdit(clip, appendAll)).catch(failed('Could not paste'));
    }
  };
  // For the keys, which listen across renders.
  const latest = useRef({ copyFrom, pasteToSelection, exportSelection, duplicateSelection, trashSelection: () => {} });

  /** Rate, flag, label or tag the selection (`then` once it's going: a large one asks first). */
  const applyToSelection = useStableCallback((patch: BulkPatch, then?: () => void) => {
    if (!grid.count) return;
    ask(grid.count, patchQuestion(patch, grid.count), () => {
      // Taken before they're kept: they match the filters it holds.
      const target = grid.allMatching ? grid.target() : undefined;
      keep(selectedPhotos.map((p) => p.id));
      bulk.mutate({ ids: [...selection], target, patch });
      then?.();
    });
  });

  // The tags' shortcuts (set from the Tags filter) toggle a tag on the selection, as P does a flag.
  const toggleTag = (tag: string) => {
    if (!grid.count) {
      toaster.create({ type: 'info', title: 'Select photos to tag first', duration: 2000 });
      return;
    }
    // Of a selection by filter, the photos shown say whether they all have it.
    const all = selectedPhotos.length > 0 && selectedPhotos.every((p) => p.tags.includes(tag));
    const n = photoCount(grid.count);
    applyToSelection(all ? { removeTags: [tag] } : { addTags: [tag] }, () =>
      toaster.create({
        type: 'success',
        title: all ? `Removed ${displayTag(tag)} from ${n}` : `Tagged ${n} ${displayTag(tag)}`,
        duration: 2000,
      }),
    );
  };
  const tagSequence = useTagShortcuts(loupe ? null : toggleTag);

  // Culling shortcuts, Lightroom/darktable style.
  const overlayKeys = useRef(new WeakSet<KeyboardEvent>());
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
        void latest.current.copyFrom(e.shiftKey);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && key === 'v' && grid.count) {
        e.preventDefault();
        latest.current.pasteToSelection(e.shiftKey);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && key === 'e') {
        e.preventDefault();
        latest.current.exportSelection();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && key === 'd') {
        e.preventDefault();
        latest.current.duplicateSelection(e.shiftKey);
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
      else if ((key === 'delete' || key === 'backspace') && grid.count) latest.current.trashSelection();
      else if (key === 'escape') grid.clear();
      else return;
      e.preventDefault();
    };
    // Keys pressed in an open dialog (confirmations are alert dialogs) or menu are theirs:
    // Escape closes it and mustn't also clear the selection, Space presses its button.
    // Checked before they handle it (a menu closes on Escape at once). Kept across runs
    // of this effect: closing a drawer renders the page again during the same key press.
    const forOverlay = overlayKeys.current;
    const claim = (e: KeyboardEvent) => {
      const overlay = '[role="dialog"], [role="alertdialog"], [role="menu"][data-state="open"]';
      if (document.querySelector(overlay)) forOverlay.add(e);
      else if (!loupe) {
        // Space or Enter on a button: the button's if the keyboard focused it, else the library's.
        const owner = buttonKey(e);
        if (owner === 'button') forOverlay.add(e);
        else if (owner === 'page') onKey(e);
      }
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
    navigate,
  ]);

  // ── Import (button or drag & drop) ──
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);

  /** Move the selection to the trash (with Undo); a large one asks first. */
  const trashSelection = () => {
    if (!grid.count) return;
    const target = grid.allMatching ? grid.target() : undefined;
    const versions = selectedPhotos;
    ask(
      grid.count,
      {
        title: `Move ${photoCount(grid.count)} to the trash?`,
        body: 'They can be restored from the trash for 30 days.',
        confirm: 'Move to trash',
        danger: true,
      },
      () => void moveToTrash(versions, target).catch(failed('Could not move to the trash')),
    );
  };
  latest.current = { copyFrom, pasteToSelection, exportSelection, duplicateSelection, trashSelection };

  /** What the info panel does, on the selection. */
  const infoActions = {
    onPatch: applyToSelection,
    onDelete: trashSelection,
    onDuplicate: duplicateSelection,
    onApplyEdit: editSelection,
    onCopy: () => void copyFrom(true),
    onExport: exportSelection,
    onSend: sendSelection,
    onMoveToCollection: moveSelectionToCollection,
    // A history entry of its own: Back returns to the filters before.
    onShowFilter: (key: 'tag' | 'collection', value: string) =>
      search.edit(
        (next) => {
          for (const k of [...new Set(next.keys())]) if (k !== 'sort') next.delete(k);
          next.set(key, value);
        },
        { push: true },
      ),
  };

  const sortSelect = <SortSelect search={search} />;
  const applyButton = outside > 0 && (
    <Button
      size={HEADER_SIZE}
      variant="outline"
      colorPalette="orange"
      flexShrink="0"
      onClick={() => applyFilters(search.search)}
      title={`${photoCount(outside)} changed here no longer ${outside === 1 ? 'matches' : 'match'} the filters: apply them again to hide ${outside === 1 ? 'it' : 'them'}`}
    >
      <ListRestart />
      <Text as="span" hideBelow="md">
        Apply filters
      </Text>
      <Badge size="xs" colorPalette="orange" variant="solid" fontFamily="numeric">
        {outside}
      </Badge>
    </Button>
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
      {askDialog}
      {tagSequence}
      <PanelDrawer
        narrow={narrow}
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        placement="start"
        title="Sort and filter"
      >
        {narrow && (
          <Box px="3" pt="3" pb="1.5" bg="bg.panel">
            {sortSelect}
          </Box>
        )}
        <FilterSidebar search={search} />
      </PanelDrawer>

      <Flex direction="column" flex="1" minW="0">
        <HStack px="3" py="2" borderBottomWidth="1px" gap={{ base: '2', md: '3' }} bg="bg.panel">
          <AppMenu />
          <InputGroup startElement={<Search size={14} />} maxW={{ md: 'xs' }} flex={{ base: '1', md: 'initial' }}>
            <Input
              size={HEADER_SIZE}
              placeholder="Search filename, title, tags…"
              defaultValue={search.params.get('q') ?? ''}
              onChange={(e) => search.set('q', e.target.value)}
            />
          </InputGroup>
          {narrow && (
            <IconButton
              size={HEADER_SIZE}
              variant="outline"
              aria-label="Sort and filter"
              onClick={() => setFiltersOpen(true)}
              position="relative"
            >
              <Filter />
              {search.activeFilterCount > 0 && (
                <Badge
                  size="xs"
                  colorPalette="orange"
                  variant="solid"
                  position="absolute"
                  top="-1.5"
                  insetEnd="-1.5"
                  rounded="full"
                  fontFamily="numeric"
                >
                  {search.activeFilterCount}
                </Badge>
              )}
            </IconButton>
          )}
          {narrow ? (
            applyButton
          ) : (
            <>
              {sortSelect}
              {applyButton}
              <Box flex="1" />
              <Button
                size={HEADER_SIZE}
                variant="outline"
                disabled={!photos.length}
                onClick={() => setLoupe(loupeStart ?? photos[0]!.id)}
                title="Culling view (Space)"
              >
                <Maximize /> Cull
              </Button>
            </>
          )}
          {narrow ? (
            <IconButton
              size={HEADER_SIZE}
              colorPalette="orange"
              aria-label="Import photos"
              onClick={() => importFrom('files')}
            >
              <Upload />
            </IconButton>
          ) : (
            // The menu around the group: the group styles its direct children (the
            // trigger's corners, where they meet), and a menu inside it would be one.
            <Menu.Root positioning={{ placement: 'bottom-end' }}>
              <ButtonGroup size={HEADER_SIZE} colorPalette="orange" attached>
                <Button onClick={() => importFrom('files')} title="Import RAW files">
                  <Upload /> Import
                </Button>
                <Menu.Trigger asChild>
                  <IconButton aria-label="More ways to import" borderStartWidth="1px" borderStartColor="whiteAlpha.500">
                    <ChevronDown />
                  </IconButton>
                </Menu.Trigger>
              </ButtonGroup>
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
          )}
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={IMPORT_ACCEPT}
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
            onClick={narrow ? tap : grid.onClick}
            onOpen={narrow ? undefined : openDevelop}
            onLongPress={narrow ? longPress : undefined}
          />
        )}
        {narrow && grid.count > 0 ? (
          <SelectionBar
            selected={grid.count}
            total={photos.length}
            onSelectAll={grid.selectAll}
            onDetails={() => setInfoOpen(true)}
            onDone={grid.clear}
          />
        ) : (
          <LibraryStatusBar
            selected={grid.count}
            allMatching={grid.allMatching}
            total={total}
            developing={photos.filter((p) => p.renderStatus === 'pending').length}
            loading={library.isFetching && !library.isPending}
            columns={columns}
            range={columnRange}
            onColumnsChange={setColumns}
          />
        )}
      </Flex>

      {/* The selection's (on phones in the loupe, the photo shown is selected while it's open). */}
      <PanelDrawer
        narrow={narrow}
        open={infoOpen}
        onClose={() => setInfoOpen(false)}
        placement="bottom"
        title="Details"
      >
        <InfoPanel selected={selectedPhotos} count={grid.count} {...infoActions} />
      </PanelDrawer>
      <CollectionPicker request={collectionPicker} onClose={() => setCollectionPicker(null)} />
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
          onChange={(id, patch) => {
            keep([id]);
            bulk.mutate({ ids: [id], patch });
          }}
          onPaste={pasteTo}
          onClose={(id) => {
            setLoupe(null);
            // On phones a selection means taps select: closing doesn't start one.
            if (narrow) grid.clear();
            else selectOne(id);
          }}
          onDevelop={narrow ? undefined : (id) => navigate(`/versions/${id}/develop`)}
          // Phones: the info panel is below the photo, for the photo shown (selected meanwhile).
          onShow={narrow ? selectOne : undefined}
          details={narrow ? (photo) => <InfoPanel selected={[photo]} count={1} inLoupe {...infoActions} /> : undefined}
        />
      )}
    </Flex>
  );
}
