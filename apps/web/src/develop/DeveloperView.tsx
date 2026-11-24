import { Box, Button, Center, Flex, Grid, HStack, IconButton, Spinner, Stack, Text } from '@chakra-ui/react';
import {
  AUTO_TUNE_SIZE,
  type CropRect,
  EXPORT_FORMATS,
  type EditParams,
  type ExportSettings,
  type PhotoMetadata,
  type Style,
  AUTO_TUNE_KINDS,
  AUTO_RECIPE_LABEL,
  AUTO_RECIPE_LABELS,
  applyStyle,
  forPhoto,
  clearAutoTunes,
  exportFilename,
  exportOptions,
  findModule,
  fromSensor,
  hasPendingAutoTune,
  illuminantFromXy,
  resolveAutoTunes,
  roundFilmicExposure,
  roundToneRange,
  toSensor,
  updateInstance,
  updateModule,
  lensfunShot,
  exposurePhotos,
  type PhotoRef,
} from '@rawtisserie/pipeline';
import { Check, ChevronsLeftRight, Download, X } from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppMenu } from '../components/AppMenu.tsx';
import { backendMeasures } from './autoTune.ts';
import { toaster } from '../components/toaster.tsx';
import { captureLine } from '../lib/format.ts';
import {
  type CropAspect,
  FREE_ASPECT,
  aspectRatio,
  constrainAspect,
  flipCrop,
  isCropped,
  isPortrait,
} from './aspect.ts';
import { CropOverlay } from './CropOverlay.tsx';
import { CompareMenu } from './CompareMenu.tsx';
import { Spotlight } from './Spotlight.tsx';
import { useSpotlightPanel } from './useSpotlightPanel.ts';
import {
  type CompareLayout,
  type CompareTarget,
  type CompareVersion,
  compareRecipe,
  splitClip,
  framingKey,
  targetLabel,
} from './compare.ts';
import { type HistorySnapshot, HistoryStore } from './history.ts';
import { HistoryPanel, useHistoryOpen } from './HistoryPanel.tsx';
import { defaultRecipeFor } from './lensfun.ts';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { ModulePanel } from './ModulePanel.tsx';
import {
  copyEdits,
  lastSelection,
  pasteEdit,
  readClipboard,
  rememberPick,
  sourceName,
  useClipboard,
} from './editClipboard.ts';
import { CopyEditsDialog, CreateStyleDialog, type StyleSelection, StyleMenu, usePresetLibrary } from './presets.tsx';
import { type LutChoice, useLutLibrary, useMissingLuts } from './luts.ts';
import { useRecipePreview } from './preview.ts';
import { ThumbnailContext, useThumbnailCache } from './thumbnails.tsx';
import { SampleContext, SampleStore } from './picker.ts';
import { MAX_PINS, PinMarkers, PinnedSamples } from './PinnedSamples.tsx';
import { GuideOverlay } from './GuideOverlay.tsx';
import type {
  DenoiseStatus,
  GuideLine,
  IlluminantDetection,
  PerspectiveFit,
  ToneCurveInput,
  ToneCurveView,
  ToneRangeView,
} from './protocol.ts';
import { DEFAULT_SHAPE_UI, type ShapeUi } from './retouch.ts';
import { ShapeOverlay } from './ShapeOverlay.tsx';
import type { Frame, RenderBackend } from './renderBackend.ts';
import type { Placement } from './protocol.ts';
import { saveBlob } from '../lib/download.ts';
import { ExportDialog } from './ExportDialog.tsx';
import type { ExportInfo } from './exportInfo.ts';
import { useExportSetup } from './useExportSettings.ts';
import { ScopePanel, scopeHeight, useScopeSettings } from './ScopePanel.tsx';
import { StatusBar, useClippingSettings } from './StatusBar.tsx';
import { type SaveFn, useAutosave } from './useAutosave.ts';
import { useRenderLoop } from './useRenderLoop.ts';
import { useStableCallback } from './useStableCallback.ts';
import { type ZoomLayout, visibleRegion } from './zoom.ts';
import { useElementSize } from '../lib/useElementSize.ts';
import { useZoom } from './useZoom.ts';
import { ImportNotice } from './ImportNotice.tsx';
import { ZEN_HIDE, ZenButton, useZen } from './zen.tsx';
import { commandLabel } from '../lib/keys.ts';
import { HEADER_SIZE } from '../lib/headerSize.ts';

interface Props {
  backend: RenderBackend;
  filename: string;
  metadata: PhotoMetadata;
  /** What exports write in their metadata and file names can refer to. */
  exportInfo: ExportInfo;
  /** The recipe of the unedited image (history entry 0). */
  original: EditParams;
  initialHistory: HistorySnapshot;
  /** Mirror history changes on the server (library mode). */
  save?: SaveFn;
  /** The version's `revision` that `initialHistory` comes from. */
  revision?: number;
  /**
   * The history it should start with instead, which the server doesn't have yet (a new
   * upload opened before its first render): shown and saved at once.
   */
  startWith?: HistorySnapshot | null;
  /** Edits from another application the version was imported with: warned about while their entry is current. */
  importedEdits?: string | null;
  /** Extra toolbar actions, given the current history. */
  actions?: (history: HistorySnapshot) => React.ReactNode;
  /** Shown next to the file name (the version switcher), given a way to wait for pending saves. */
  versions?: (whenSaved: () => Promise<void>) => React.ReactNode;
  /** The photo's other versions, to compare with (roadmap M5). */
  compareVersions?: readonly CompareVersion[];
  /** Go back to where the photo was opened from (Esc). */
  onBack?: () => void;
  /**
   * Ask the user for another photo to blend in (multiple exposure), which the backend's
   * exposure source can then give; null if they didn't pick one.
   */
  chooseExposure?: (current: PhotoRef | null) => Promise<PhotoRef | null>;
}

const NO_MISSING: ReadonlySet<string> = new Set();
const NO_VERSIONS: readonly CompareVersion[] = [];
/** Between the two images side by side, in CSS pixels. */
const COMPARE_GAP = 8;

/** The other photos `params` blends in (multiple exposure) that `backend` can't have. */
function useMissingExposures(backend: RenderBackend, params: EditParams): ReadonlySet<string> {
  const shas = exposurePhotos(params).join(' ');
  const [missing, setMissing] = useState(NO_MISSING);
  useEffect(() => {
    let cancelled = false;
    const wanted = shas ? shas.split(' ') : [];
    void Promise.all(wanted.map(async (sha) => ((await backend.hasExposure(sha)) ? [] : [sha]))).then((found) => {
      const now = found.flat();
      if (!cancelled)
        setMissing((old) => (old.size === now.length && now.every((s) => old.has(s)) ? old : new Set(now)));
    });
    return () => {
      cancelled = true;
    };
  }, [backend, shas]);
  return missing;
}

/**
 * The side panels are mostly sliders: a drag that strays off one mustn't select their
 * text. What's typed into fields stays selectable.
 */
const NO_SELECT = { userSelect: 'none', '& input, & textarea': { userSelect: 'text' } } as const;

const MAX_PREVIEW = 3200;
/** Rendering takes ~70 ns per pixel, so this allows ~25 image updates per second during a drag. */
const DRAFT_PIXELS = 500_000;
const FULL_CROP: CropRect = { x: 0, y: 0, width: 1, height: 1 };
/** Perspective guides are detected on a render within this size (device pixels). */
const GUIDES_MAX = 1600;
/** Width of the zebra stripes, in CSS pixels. */
const STRIPE_PX = 4;
/** The toast offering to undo a truncation or compression of the history. */
const UNDO_TOAST = 'history-undo';

/** No pinned samples (the same array, so nothing is sent again). */
const NO_PLACES: [number, number][] = [];

/**
 * Layout of the ISO 12646 assessment mode: the image shrinks, gets a white frame,
 * and is surrounded by a wide neutral grey margin.
 */
function assessmentLayout(size: { width: number; height: number }, on: boolean) {
  const short = Math.min(size.width, size.height);
  if (!on) return { margin: 16, frameWidth: 0 };
  return { margin: Math.max(32, Math.round(short * 0.06)), frameWidth: Math.max(12, Math.round(short * 0.03)) };
}

/** Show the spinner once the image has waited this long for a new render. */
const SPINNER_DELAY_MS = 500;
/** How long commits must settle before tone curve inputs are measured again. */
const TONE_MEASURE_DELAY_MS = 500;

/**
 * In a corner of the image while a render is overdue: after `SPINNER_DELAY_MS` without
 * a new frame, with renders still to come (a slow zoomed-in view, or slow frames during
 * a drag). It stays until the renders catch up, and fades in and out.
 */
function RenderSpinner({ busy, frame }: { busy: boolean; frame: Frame | null }) {
  const [shown, setShown] = useState(false);
  // Kept while it fades out.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (!busy) return setShown(false);
    if (shown) return;
    // Restarted by every new frame.
    const timer = setTimeout(() => {
      setShown(true);
      setMounted(true);
    }, SPINNER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [busy, frame, shown]);
  if (!mounted) return null;
  return (
    <Center
      position="absolute"
      top="3"
      right="3"
      boxSize="8"
      bg="bg.panel"
      borderRadius="full"
      boxShadow="md"
      pointerEvents="none"
      title="Rendering…"
      animationName={shown ? 'fade-in' : 'fade-out'}
      animationDuration="fast"
      animationFillMode="forwards"
      onAnimationEnd={() => !shown && setMounted(false)}
    >
      <Spinner size="sm" color="orange.solid" />
    </Center>
  );
}

/** Memoised, like the panels: a slider drag or a new frame leaves it alone. */
const Toolbar = memo(function Toolbar({
  filename,
  metadata,
  versions,
  styles,
  compare,
  exporting,
  actions,
  onExport,
}: {
  filename: string;
  metadata: PhotoMetadata;
  versions: React.ReactNode;
  /** The styles menu, with an account. */
  styles: React.ReactNode;
  /** The Compare button and its menu. */
  compare: React.ReactNode;
  exporting: boolean;
  actions: React.ReactNode;
  /** Opens the export dialog. */
  onExport: () => void;
}) {
  const exif = captureLine({
    focalLength: metadata.focalLength,
    fNumber: metadata.fNumber,
    exposureTime: metadata.exposureTime,
    iso: metadata.iso,
    lens: metadata.lensModel,
    make: metadata.make,
    model: metadata.model,
  });

  return (
    <HStack px="3" py="2" borderBottomWidth="1px" gap="2" {...ZEN_HIDE}>
      <AppMenu />
      {/* Two small lines, within the height of the header's buttons (as the library's). */}
      <Stack gap="0" minW="0" flex="1">
        <HStack gap="1" minW="0" h="4">
          <Text textStyle="xs" fontWeight="semibold" truncate>
            {filename}
          </Text>
          {versions}
        </HStack>
        <Text textStyle="2xs" fontFamily="numeric" color="fg.muted" truncate title={exif.join(' · ')}>
          {exif.join(' · ')}
        </Text>
      </Stack>
      {styles}
      {compare}
      <Button
        size={HEADER_SIZE}
        variant="outline"
        loading={exporting}
        loadingText="Exporting…"
        onClick={onExport}
        title={`Export (${commandLabel('Ctrl+E')})`}
      >
        <Download /> Export
      </Button>
      {actions}
    </HStack>
  );
});

/** Where a region render goes over the fitted image (hidden without one). */
function regionStyle(region: Placement | null, frame: Frame | null): React.CSSProperties {
  if (!region || !frame) return { display: 'none' };
  return {
    position: 'absolute',
    left: `${(100 * region.x) / region.frameWidth}%`,
    top: `${(100 * region.y) / region.frameHeight}%`,
    width: `${(100 * region.width) / region.frameWidth}%`,
    height: `${(100 * region.height) / region.frameHeight}%`,
    // Rendered at 100 %: larger zoom levels enlarge its pixels.
    imageRendering: region.frameWidth >= frame.sourceWidth ? 'pixelated' : 'auto',
  };
}

/** What an image of the comparison shows, over its top corner. */
function PaneLabel({ children, side = 'left' }: { children: React.ReactNode; side?: 'left' | 'right' }) {
  return (
    <Text
      position="absolute"
      top="3"
      {...(side === 'left' ? { left: '3' } : { right: '3' })}
      maxW="calc(100% - 1.5rem)"
      truncate
      px="2"
      py="0.5"
      borderRadius="sm"
      bg="blackAlpha.700"
      color="white"
      textStyle="xs"
      pointerEvents="none"
    >
      {children}
    </Text>
  );
}

/**
 * The split view's divider (roadmap M5): the compared image shows on its left, the edited
 * one on its right. Across the whole pane, where `split` places it.
 */
const SplitDivider = memo(function SplitDivider({
  split,
  onChange,
  before,
}: {
  split: number;
  onChange: (split: number) => void;
  /** What the compared image is. */
  before: string;
}) {
  const area = useRef<HTMLDivElement>(null);
  const handlers = {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const r = area.current?.getBoundingClientRect();
      if (!r || !e.currentTarget.hasPointerCapture(e.pointerId) || r.width <= 0) return;
      onChange(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
    },
    onDoubleClick: () => onChange(0.5),
  };
  return (
    <Box ref={area} position="absolute" inset="0" data-split-divider>
      <Box position="absolute" top="0" bottom="0" w="0" style={{ left: `${split * 100}%` }}>
        <Box
          position="absolute"
          top="0"
          bottom="0"
          left="-1px"
          w="2px"
          bg="white"
          boxShadow="0 0 3px rgba(0, 0, 0, 0.6)"
        />
        <Box
          position="absolute"
          top="0"
          bottom="0"
          left="-6px"
          w="12px"
          cursor="ew-resize"
          pointerEvents="auto"
          touchAction="none"
          title="Drag to move the divider · Double-click to centre it"
          {...handlers}
        />
        <Center
          position="absolute"
          top="50%"
          left="0"
          transform="translate(-50%, -50%)"
          boxSize="7"
          borderRadius="full"
          bg="white"
          color="black"
          boxShadow="md"
          cursor="ew-resize"
          pointerEvents="auto"
          touchAction="none"
          {...handlers}
        >
          <ChevronsLeftRight size={16} />
        </Center>
        <Box position="absolute" top="0" right="0" w="40vw">
          <PaneLabel side="right">{before}</PaneLabel>
        </Box>
        <Box position="absolute" top="0" left="0" w="40vw">
          <PaneLabel>Current</PaneLabel>
        </Box>
      </Box>
    </Box>
  );
});

export function DeveloperView({
  backend,
  filename,
  metadata,
  exportInfo,
  original,
  initialHistory,
  save,
  revision = 0,
  startWith,
  importedEdits = null,
  actions,
  versions,
  compareVersions,
  onBack,
  chooseExposure,
}: Props) {
  const [store] = useState(() => new HistoryStore(original, initialHistory));
  const history = useSyncExternalStore(store.subscribe, store.getState);
  const params = history.live;
  const committed = history.entries[history.end - 1]?.recipe ?? original;
  /** A live change (e.g. a slider being dragged) has not been committed yet. */
  const live = params !== committed;
  const autosave = useAutosave(store, revision, save);
  // After the autosave's effect, which listens to the store.
  useEffect(() => {
    if (startWith && store.getState().entries.length === 0) store.restore(startWith);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on open
  }, []);

  /** The original shows while \ is held. */
  const [comparing, setComparing] = useState(false);
  // The spotlight (roadmap 2.6, a prototype), and what it shows of the panel.
  const spotlight = useSpotlightPanel();

  // Compare (roadmap M5): another history entry or version beside the edited image, with
  // the edited image's lens correction and geometry (`compareRecipe`).
  const [compareOn, setCompareOn] = useState(false);
  const [compareLayout, setCompareLayout] = useState<CompareLayout>(() =>
    localStorage.getItem('developer.compareLayout') === 'sideBySide' ? 'sideBySide' : 'split',
  );
  useEffect(() => localStorage.setItem('developer.compareLayout', compareLayout), [compareLayout]);
  const [compareTarget, setCompareTarget] = useState<CompareTarget>({ kind: 'history', seq: 0 });
  // Where the split view's divider is, as a fraction of the image's window.
  const [split, setSplit] = useState(0.5);
  const otherVersions = compareVersions ?? NO_VERSIONS;
  // The compared version's recipe, once loaded.
  const [versionRecipe, setVersionRecipe] = useState<{ id: string; recipe: EditParams } | null>(null);
  const targetVersion =
    compareTarget.kind === 'version' ? otherVersions.find((v) => v.id === compareTarget.id) : undefined;
  useEffect(() => {
    if (!compareOn || !targetVersion || versionRecipe?.id === targetVersion.id) return;
    let cancelled = false;
    targetVersion.recipe().then(
      (recipe) => !cancelled && setVersionRecipe({ id: targetVersion.id, recipe }),
      (err: unknown) => {
        if (cancelled) return;
        toaster.create({
          type: 'error',
          title: 'Could not load the version to compare with',
          description: err instanceof Error ? err.message : undefined,
        });
        setCompareTarget({ kind: 'history', seq: 0 });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [compareOn, targetVersion, versionRecipe?.id]);
  // An entry dropped since it was picked: the original.
  const targetRecipe =
    compareTarget.kind === 'history'
      ? compareTarget.seq <= history.entries.length
        ? store.recipeAt(compareTarget.seq)
        : original
      : versionRecipe?.id === compareTarget.id
        ? versionRecipe.recipe
        : null;
  // ISO 12646 colour assessment: a white frame around a smaller image on neutral grey.
  const zen = useZen();
  const [assessment, setAssessment] = useState(() => localStorage.getItem('developer.assessment') === '1');
  useEffect(() => localStorage.setItem('developer.assessment', assessment ? '1' : '0'), [assessment]);
  const [clipping, setClipping] = useClippingSettings();
  const [scopes, setScopes] = useScopeSettings();
  const [cropDraft, setCropDraft] = useState<CropRect | null>(null);
  // Raw denoise runs beside renders: its progress for the panel, and a render once it's done.
  const [denoise, setDenoise] = useState<DenoiseStatus | null>(null);
  const [denoisedRenders, setDenoisedRenders] = useState(0);
  const denoiseState = useRef<DenoiseStatus['state'] | null>(null);
  useEffect(
    () =>
      backend.onDenoiseStatus((status) => {
        if (status.state === 'ready' && denoiseState.current !== 'ready') setDenoisedRenders((n) => n + 1);
        denoiseState.current = status.state;
        setDenoise(status);
      }),
    [backend],
  );
  // Perspective guides while they are edited (null otherwise): the whole corrected image
  // shows, and fits change the live recipe until applied.
  const [guides, setGuides] = useState<GuideLine[] | null>(null);
  const [detectingLines, setDetectingLines] = useState(false);
  // The last fit while editing guides: run again whenever they change.
  const [guideFit, setGuideFit] = useState<PerspectiveFit | null>(null);
  const [fittingPerspective, setFittingPerspective] = useState<PerspectiveFit | null>(null);
  // The crop aspect picked in this session, or null for the default (see `aspect` below).
  const [pickedAspect, setAspect] = useState<CropAspect | null>(null);
  const [exporting, setExporting] = useState(false);
  const [autoTuning, setAutoTuning] = useState(false);
  const [detecting, setDetecting] = useState<string | null>(null);
  // What each tone curve instance reads on its input, by id (see `measureToneCurves`).
  const [toneInputs, setToneInputs] = useState<Readonly<Record<string, ToneCurveInput>>>({});
  const [fittingTone, setFittingTone] = useState<string | null>(null);
  const [shapeState, setShapeUi] = useState<ShapeUi>(DEFAULT_SHAPE_UI);

  // The retouch instance being edited, or the first one if it was removed (undo, delete).
  // A mask's instance may not exist yet (its kind has none): its first shape adds it.
  const editedInstance =
    shapeState.target === 'mask' || params.modules.some((m) => m.id === shapeState.instance)
      ? shapeState.instance
      : (findModule(params, 'retouch')?.id ?? DEFAULT_SHAPE_UI.instance);
  const shapeUi = useMemo(
    () => (editedInstance === shapeState.instance ? shapeState : { ...shapeState, instance: editedInstance }),
    [shapeState, editedInstance],
  );
  // The mask shown over the image, while its instance has one.
  const shown = shapeUi.maskOverlay;
  const maskOverlay = shown && params.modules.some((m) => m.id === shown.id && m.mask) ? shown : null;
  // What a tone curve reads, shown over the image instead (one overlay at a time).
  const [toneView, setToneView] = useState<ToneCurveView | null>(null);
  const toneOverlay = toneView && params.modules.some((m) => m.id === toneView.id) ? toneView : null;
  // Or where a colour balance range applies.
  const [rangeView, setRangeView] = useState<ToneRangeView | null>(null);
  const rangeOverlay = rangeView && params.modules.some((m) => m.id === rangeView.id) ? rangeView : null;
  useEffect(() => {
    if (shapeUi.maskOverlay) {
      setToneView(null);
      setRangeView(null);
    }
  }, [shapeUi.maskOverlay]);

  // ── Rendering ──
  const [viewport, size] = useElementSize<HTMLDivElement>();
  const dpr = window.devicePixelRatio || 1;
  // Zoom (`useZoom.ts`): the fitted render is scaled up at once, and a render of the
  // visible region follows when the view stops moving. The layout is set below, once
  // the fitted frame is known.
  const zoomWindow = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const zoomLayout = useRef<ZoomLayout | null>(null);
  // The compared image's window and stage, which the zoom moves with the edited image's.
  const compareWindow = useRef<HTMLDivElement>(null);
  const compareStage = useRef<HTMLDivElement>(null);
  const { view: zoom, zoomTo } = useZoom(zoomWindow, stage, zoomLayout, !cropDraft, {
    mirror: { window: compareWindow, stage: compareStage },
  });
  // The colour picker (roadmap 2.7): the pointer's place over the image goes to the
  // worker (once a frame at most), the pixel there comes back into a store that only
  // what shows it reads (`picker.ts`).
  const samples = useMemo(() => new SampleStore(), []);
  // What the lens module's picker needs of the photo: stable, for the memoised panel.
  const lensShot = useMemo(() => lensfunShot(metadata), [metadata]);
  useEffect(() => backend.onSample((s, pins) => samples.set(s, pins)), [backend, samples]);
  // Zoomed in, the worker reads the region render first (the whole one stays as it was).
  const pointer = useRef<{ at: [number, number] | null; zoomed: boolean }>({ at: null, zoomed: false });
  const zoomedIn = zoom !== null;
  useEffect(() => {
    pointer.current.zoomed = zoomedIn;
    backend.pointer(pointer.current.at, zoomedIn);
  }, [backend, zoomedIn]);
  // Listened to on the zoom window, which holds the pointer while panning (zoomed in), and
  // measured on the image (the stage) inside it.
  useEffect(() => {
    const win = zoomWindow.current;
    const el = stage.current;
    if (!win || !el) return;
    let at: [number, number] | null = null;
    let queued = 0;
    const send = () => {
      queued = 0;
      pointer.current.at = at;
      backend.pointer(at, pointer.current.zoomed);
    };
    const queue = () => void (queued ||= requestAnimationFrame(send));
    const move = (e: PointerEvent) => {
      // A finger is busy panning: no pointer to follow.
      if (e.pointerType === 'touch') return;
      const r = el.getBoundingClientRect();
      const [u, v] = [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
      at = u >= 0 && u < 1 && v >= 0 && v < 1 ? [u, v] : null;
      queue();
    };
    const leave = () => {
      at = null;
      queue();
    };
    win.addEventListener('pointermove', move);
    win.addEventListener('pointerleave', leave);
    return () => {
      win.removeEventListener('pointermove', move);
      win.removeEventListener('pointerleave', leave);
      cancelAnimationFrame(queued);
      pointer.current.at = null;
      backend.pointer(null, pointer.current.zoomed);
    };
  }, [backend]);
  // The pipette (`I`): clicks on the image pin samples, kept in sensor coordinates (as
  // shapes are, so that they stay on the same spot through crops), for this photo only.
  const [pipette, setPipette] = useState(false);
  const [pins, setPins] = useState<[number, number][]>([]);
  useEffect(() => setPins([]), [metadata]);
  /** Crop or guides: the image shows uncropped, without overlays. */
  const framing = cropDraft !== null || guides !== null;
  // Zoomed in, the fitted render is mostly hidden: it stays at the committed recipe
  // while a slider is dragged, so that only the visible region is rendered.
  const fitParams = zoom && live ? committed : params;
  const withView = (p: EditParams) => {
    if (comparing) return store.original;
    if (cropDraft) return updateModule(p, 'geometry', { params: { crop: FULL_CROP } });
    // All of the corrected image, borders included, so that every guide shows.
    if (guides) return updateModule(p, 'geometry', { params: { crop: FULL_CROP, autoCrop: 'off' } });
    return p;
  };
  const effective = useMemo(() => withView(params), [params, comparing, cropDraft !== null, guides !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  const fitEffective = useMemo(() => withView(fitParams), [fitParams, comparing, cropDraft !== null, guides !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  // While a slider is being dragged, render a ~0.5 MP draft (the pipeline keeps its
  // caches for both sizes); the full-resolution render follows on release. Fitted
  // guides are a live change too, but not a drag.
  const draft = live && !framing && !zoom;
  // Scopes of the fitted render, as wide as the sidebar allows (less its padding).
  const [sidebar, sidebarSize] = useElementSize<HTMLDivElement>();
  const scopeWidth = Math.max(0, sidebarSize.width - 16);
  const scopeCssHeight = scopeHeight(scopes.mode, scopeWidth);
  // Waveforms are binned per CSS pixel: at device pixels, the bins would be too sparse
  // for the samples (a speckled trace).
  const scopeDpr = scopes.mode === 'vectorscope' ? dpr : 1;
  const scopeRequest = useMemo(
    () =>
      scopes.open && scopeWidth > 0
        ? {
            mode: scopes.mode,
            width: Math.round(scopeWidth * scopeDpr),
            height: Math.round(scopeCssHeight * scopeDpr),
            zoom: scopes.mode === 'vectorscope' ? scopes.zoom : 1,
          }
        : null,
    [scopes.open, scopes.mode, scopes.zoom, scopeWidth, scopeCssHeight, scopeDpr],
  );
  // Not while cropping or placing guides, which show the whole uncropped image.
  const comparison = compareOn && !framing;
  const sideBySide = comparison && compareLayout === 'sideBySide';
  // Side by side, each image has half of the viewport.
  const pane = {
    width: sideBySide ? Math.max(0, Math.floor((size.width - COMPARE_GAP) / 2)) : size.width,
    height: size.height,
  };
  // It follows the edited image's committed framing, not its look.
  const committedFraming = framingKey(committed);
  const compareParams = useMemo(
    () => (comparison && targetRecipe ? compareRecipe(targetRecipe, committed) : null),
    [comparison, targetRecipe, committedFraming], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const { margin, frameWidth } = assessmentLayout(pane, assessment);
  const job = useMemo(() => {
    const inset = 2 * (margin + frameWidth);
    const width = Math.min(MAX_PREVIEW, Math.floor((pane.width - inset) * dpr));
    const height = Math.min(MAX_PREVIEW, Math.floor((pane.height - inset) * dpr));
    const scale = draft ? Math.min(1, Math.sqrt(DRAFT_PIXELS / Math.max(1, width * height))) : 1;
    const overlays = {
      display: clipping.display ? { mode: clipping.mode } : null,
      sensor: clipping.sensor,
      stripes: clipping.zebra ? STRIPE_PX * dpr * scale : 0,
      mask: comparing || framing ? null : (maskOverlay?.id ?? null),
      maskView: maskOverlay ? { part: maskOverlay.part, values: maskOverlay.values } : undefined,
      toneCurve: comparing || framing ? null : toneOverlay,
      toneRange: comparing || framing ? null : rangeOverlay,
    };
    return { params: fitEffective, width, height, scale, overlays, scope: scopeRequest };
  }, [
    denoisedRenders,
    fitEffective,
    pane.width,
    pane.height,
    dpr,
    draft,
    margin,
    frameWidth,
    clipping,
    scopeRequest,
    maskOverlay,
    toneOverlay,
    rangeOverlay,
  ]); // eslint-disable-line react-hooks/exhaustive-deps
  const { frame, error, pending } = useRenderLoop(backend, job);
  // The compared image shows the edited image's mask or tone overlay too, painted from
  // its committed recipe (on release, so a drag doesn't render it each frame).
  const comparedOverlays = useMemo(() => {
    if (comparing || framing || !(maskOverlay || toneOverlay || rangeOverlay)) return null;
    return {
      mask: maskOverlay?.id ?? null,
      maskView: maskOverlay ? { part: maskOverlay.part, values: maskOverlay.values } : undefined,
      toneCurve: toneOverlay,
      toneRange: rangeOverlay,
      recipe: committed,
    };
  }, [comparing, framing, maskOverlay, toneOverlay, rangeOverlay, committed]);
  // The compared image, at the same size, with the clipping indicators and those overlays.
  const compareJob = useMemo(
    () =>
      compareParams && {
        params: compareParams,
        width: job.width,
        height: job.height,
        scale: 1,
        overlays: {
          display: clipping.display ? { mode: clipping.mode } : null,
          sensor: clipping.sensor,
          stripes: clipping.zebra ? STRIPE_PX * dpr : 0,
          ...comparedOverlays,
        },
        compare: true,
      },
    [compareParams, job.width, job.height, clipping, dpr, denoisedRenders, comparedOverlays],
  );
  const { frame: compareFrame, pending: comparePending } = useRenderLoop(backend, compareJob);
  // The pins' places in the frame, where the worker reads them.
  // Every frame brings a new mapping object: the same one while it says the same, so
  // that a drag doesn't recompute and send them each frame.
  const mappingJson = frame ? JSON.stringify(frame.mapping) : null;
  const mapping = useMemo(() => frame?.mapping, [mappingJson]); // eslint-disable-line react-hooks/exhaustive-deps
  const pinPlaces = useMemo(
    () => (mapping && pins.length ? pins.map((p) => fromSensor(mapping, p[0], p[1]) as [number, number]) : NO_PLACES),
    [pins, mapping],
  );
  useEffect(() => backend.pins(pinPlaces), [backend, pinPlaces]);
  // Auto-tunes still pending when the photo is opened (the recipe a new image starts
  // with, or a preset or style applied from the library, before its preview was
  // rendered): run once the image is in. The automatic entry is amended; otherwise
  // they're a new entry.
  const tunedOnOpen = useRef(false);
  useEffect(() => {
    if (!frame || tunedOnOpen.current) return;
    tunedOnOpen.current = true;
    const { live, entries, end } = store.getState();
    if (!hasPendingAutoTune(live)) return;
    if (end === 1 && AUTO_RECIPE_LABELS.includes(entries[0]!.label)) void amendTuned(live);
    else void commitTuned(live, 'Auto-tune');
  }); // eslint-disable-line react-hooks/exhaustive-deps

  // The image is seen through a window: the viewport, or the inside of the ISO 12646
  // frame, which keeps its place and shape when zooming.
  const fitWidth = frame ? frame.fullWidth / dpr : 0;
  const fitHeight = frame ? frame.fullHeight / dpr : 0;
  // The compared image's window, its white frame included (assessment: centred in the pane).
  const compareWindowWidth = (assessment ? fitWidth : pane.width) + 2 * frameWidth;
  zoomLayout.current = frame && {
    windowWidth: assessment ? fitWidth : pane.width,
    windowHeight: assessment ? fitHeight : pane.height,
    fitWidth,
    fitHeight,
    fitScale: frame.fullWidth / frame.sourceWidth,
    sourceWidth: frame.sourceWidth,
    sourceHeight: frame.sourceHeight,
    dpr,
  };
  const layout = zoomLayout.current;
  const regionJob = useMemo(() => {
    const visible = layout && visibleRegion(layout, zoom);
    if (!zoom || !visible) return null;
    const { width, height, region } = visible;
    const scale = live ? Math.min(1, Math.sqrt(DRAFT_PIXELS / (region.width * region.height))) : 1;
    // Above 100 %, the render's pixels are shown enlarged.
    const enlarged = zoom.scale / visible.scale;
    const overlays = {
      display: clipping.display ? { mode: clipping.mode } : null,
      sensor: clipping.sensor,
      stripes: clipping.zebra ? Math.max(1, (STRIPE_PX * dpr * scale) / enlarged) : 0,
      mask: comparing || framing ? null : (maskOverlay?.id ?? null),
      maskView: maskOverlay ? { part: maskOverlay.part, values: maskOverlay.values } : undefined,
      toneCurve: comparing || framing ? null : toneOverlay,
      toneRange: comparing || framing ? null : rangeOverlay,
    };
    return { params: effective, width, height, region, scale, overlays };
  }, [zoom, JSON.stringify(layout), effective, live, dpr, clipping, maskOverlay, toneOverlay, rangeOverlay]); // eslint-disable-line react-hooks/exhaustive-deps
  const { frame: regionFrame, pending: regionPending } = useRenderLoop(backend, regionJob);
  const compareRegionJob = useMemo(() => {
    const visible = layout && visibleRegion(layout, zoom);
    if (!compareParams || !zoom || !visible) return null;
    const enlarged = zoom.scale / visible.scale;
    const { width, height, region } = visible;
    const overlays = {
      display: clipping.display ? { mode: clipping.mode } : null,
      sensor: clipping.sensor,
      stripes: clipping.zebra ? Math.max(1, (STRIPE_PX * dpr) / enlarged) : 0,
      ...comparedOverlays,
    };
    return { params: compareParams, width, height, region, scale: 1, overlays, compare: true };
  }, [zoom, JSON.stringify(layout), compareParams, dpr, clipping, comparedOverlays]); // eslint-disable-line react-hooks/exhaustive-deps
  const { frame: compareRegionFrame, pending: compareRegionPending } = useRenderLoop(backend, compareRegionJob);
  // A frame of the same image (not of another crop, or of the unedited image).
  const sameImage = (f: Frame | null) =>
    !!f && !!frame && f.sourceWidth === frame.sourceWidth && f.sourceHeight === frame.sourceHeight;
  // A region left from an earlier zoom may show an older recipe: zooming in again waits
  // for a new one.
  const staleRegion = useRef<Frame | null>(null);
  const staleCompareRegion = useRef<Frame | null>(null);
  if (!zoom) {
    staleRegion.current = regionFrame;
    staleCompareRegion.current = compareRegionFrame;
  }
  const region = zoom && regionFrame !== staleRegion.current && sameImage(regionFrame) ? regionFrame!.placement : null;
  const compareRegion =
    zoom && compareRegionFrame !== staleCompareRegion.current && sameImage(compareRegionFrame)
      ? compareRegionFrame!.placement
      : null;
  // Until it's rendered again, a compared image framed differently (the crop changed) is hidden.
  const compareShown = comparison && sameImage(compareFrame);

  // The bitmaps go to their canvas before the browser paints, together with the
  // placement they come with: otherwise the old one shows a frame at the new place.
  const canvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const c = canvas.current;
    // A bitmap already handed over has no size left (effects can run twice in development).
    if (!c || !frame || frame.image.width === 0) return;
    // Hands the bitmap over without copying: the canvas takes its size, and the main
    // thread never touches the pixels.
    c.getContext('bitmaprenderer')!.transferFromImageBitmap(frame.image);
  }, [frame]);
  const scopeCanvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const scope = frame?.scope;
    if (!scope || scope.image.width === 0) return;
    const c = scopeCanvas.current;
    // A scope of another mode (asked for before switching) is dropped.
    if (c && scope.mode === scopes.mode) c.getContext('bitmaprenderer')!.transferFromImageBitmap(scope.image);
    else scope.image.close();
  }, [frame]); // eslint-disable-line react-hooks/exhaustive-deps
  const regionCanvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const c = regionCanvas.current;
    if (!c || !regionFrame || regionFrame.image.width === 0) return;
    c.getContext('bitmaprenderer')!.transferFromImageBitmap(regionFrame.image);
  }, [regionFrame]);
  const compareCanvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const c = compareCanvas.current;
    if (!c || !compareFrame || compareFrame.image.width === 0) return;
    c.getContext('bitmaprenderer')!.transferFromImageBitmap(compareFrame.image);
  }, [compareFrame]);
  const compareRegionCanvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const c = compareRegionCanvas.current;
    if (!c || !compareRegionFrame || compareRegionFrame.image.width === 0) return;
    c.getContext('bitmaprenderer')!.transferFromImageBitmap(compareRegionFrame.image);
  }, [compareRegionFrame]);

  // ── History ──
  // Dropping undone entries (by editing from an earlier point) or compressing can be
  // undone from a toast, until the next history change.
  const undoToast = useRef(false);
  const dismissUndo = () => {
    if (undoToast.current) toaster.dismiss(UNDO_TOAST);
    undoToast.current = false;
  };
  const offerUndo = (title: string, snapshot: HistorySnapshot) => {
    undoToast.current = true;
    toaster.create({
      id: UNDO_TOAST,
      type: 'info',
      title,
      action: { label: 'Undo', onClick: () => store.restore(snapshot) },
      onStatusChange: ({ status }) => status === 'unmounted' && (undoToast.current = false),
    });
  };
  const commit = (p?: EditParams, label?: string) => {
    if (p && hasPendingAutoTune(p)) return void commitTuned(p, label);
    commitNow(p, label);
  };
  /**
   * Commit `p` once the auto-tunes a preset or style asked for (roadmap 8.7) have run on
   * it, as one entry. If they fail, it's committed with its values as they are.
   */
  const commitTuned = (p: EditParams, label?: string) => tuned(p, (r) => commitNow(r, label));
  /** The automatic entry (`p`, current), its auto-tunes run, unless something else was committed meanwhile. */
  const amendTuned = (p: EditParams) =>
    tuned(p, (r) => {
      if (store.committed === p) store.amend(r);
    });
  const tuned = async (p: EditParams, done: (resolved: EditParams) => void) => {
    setAutoTuning(true);
    try {
      done(await resolveAutoTunes(p, backendMeasures(backend)));
    } catch (err) {
      done(clearAutoTunes(p));
      toaster.create({
        type: 'error',
        title: 'Auto-tune failed',
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setAutoTuning(false);
    }
  };
  const commitNow = (p?: EditParams, label?: string) => {
    const snapshot = store.snapshot();
    const dropped = store.commit(p, undefined, label);
    if (store.snapshot().entries === snapshot.entries) return;
    dismissUndo();
    if (dropped) offerUndo(`Dropped ${dropped} undone history ${dropped === 1 ? 'entry' : 'entries'}`, snapshot);
  };
  const goto = (seq: number) => {
    dismissUndo();
    setCropDraft(null);
    setGuides(null);
    store.goto(seq);
  };
  const compress = () => {
    dismissUndo();
    setCropDraft(null);
    setGuides(null);
    const snapshot = store.snapshot();
    store.compress();
    offerUndo('History compressed', snapshot);
  };
  /**
   * Start again as a new import does: the original, then the automatic recipe (its
   * auto-tunes run), every other entry dropped. Asked first; a toast can undo it.
   */
  const resetHistory = () => {
    dismissUndo();
    setCropDraft(null);
    setGuides(null);
    const snapshot = store.snapshot();
    const recipe = defaultRecipeFor(metadata);
    store.restore({ entries: [{ label: AUTO_RECIPE_LABEL, recipe, createdAt: new Date().toISOString() }], end: 1 });
    if (hasPendingAutoTune(recipe)) void amendTuned(recipe);
    offerUndo('History reset', snapshot);
  };
  const [historyOpen, toggleHistory] = useHistoryOpen();
  const [confirmReset, setConfirmReset] = useState(false);
  const onSelectEntry = useStableCallback(goto);
  const onCompress = useStableCallback(compress);
  const onReset = useStableCallback(() => setConfirmReset(true));
  const onUndo = useStableCallback(() => goto(history.end - 1));
  const onRedo = useStableCallback(() => goto(history.end + 1));

  // ── Crop ──
  const frameAspect = frame ? frame.fullWidth / frame.fullHeight : 1;
  const geometry = findModule(params, 'geometry')?.params;
  // The photo's, before the correction and auto-crop: what "Original" crops to.
  const originalAspect =
    metadata.width && metadata.height
      ? (geometry?.rotation ?? 0) % 2
        ? metadata.height / metadata.width
        : metadata.width / metadata.height
      : frameAspect;
  const crop = geometry?.crop ?? FULL_CROP;
  // Until one is picked, "Original" in the crop's orientation (the photo's when uncropped),
  // unless the photo already has a crop of another shape: free-form then, so editing it
  // doesn't snap it.
  const cropRatio = (crop.width * frameAspect) / crop.height;
  const defaultAspect = !isCropped(crop)
    ? originalAspect < 1
      ? 'portrait'
      : 'landscape'
    : Math.abs(Math.abs(Math.log(cropRatio)) - Math.abs(Math.log(originalAspect))) < 0.005
      ? cropRatio < 1
        ? 'portrait'
        : 'landscape'
      : 'free';
  const aspect = useMemo(
    () =>
      pickedAspect ??
      (defaultAspect === 'free'
        ? FREE_ASPECT
        : { preset: 'original', custom: '', flipped: defaultAspect === 'portrait' }),
    [pickedAspect, defaultAspect],
  );
  const startCrop = () => {
    if (cropDraft) return applyCrop();
    if (guides) applyGuides();
    setCropDraft(crop);
  };
  const applyCrop = () => {
    if (!cropDraft) return;
    commit(updateModule(params, 'geometry', { enabled: true, params: { crop: cropDraft } }));
    setCropDraft(null);
  };
  /** Switch to `next`, fitting the crop (from `rect`, or the current one) to it. */
  const setCropAspect = (next: CropAspect, rect?: CropRect) => {
    setAspect(next);
    const ratio = aspectRatio(next, originalAspect);
    const base = rect ?? cropDraft;
    if (base) setCropDraft(constrainAspect(base, ratio, frameAspect));
    else if (ratio) setCropDraft(constrainAspect(crop, ratio, frameAspect));
  };
  // A preset keeps the crop's orientation, "Original" takes the photo's; a typed ratio is
  // taken as written.
  const changeAspect = (preset: string) =>
    setCropAspect({
      ...aspect,
      preset,
      flipped:
        preset === 'original' ? originalAspect < 1 : preset !== 'custom' && isPortrait(cropDraft ?? crop, frameAspect),
    });
  const changeCustomAspect = (custom: string) => setCropAspect({ preset: 'custom', custom, flipped: false });
  const flipAspect = () =>
    setCropAspect({ ...aspect, flipped: !aspect.flipped }, flipCrop(cropDraft ?? crop, frameAspect));

  // ── Perspective ──
  const detectGuides = async () => {
    setDetectingLines(true);
    try {
      const lines = await backend.detectLines(
        params,
        Math.min(job.width, GUIDES_MAX),
        Math.min(job.height, GUIDES_MAX),
      );
      // Unless the guides were closed meanwhile.
      setGuides((g) => g && lines);
      if (!lines.length)
        toaster.create({ type: 'info', title: 'No straight lines found', description: 'Draw some on the image.' });
    } catch (err) {
      toaster.create({
        type: 'error',
        title: 'Line detection failed',
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setDetectingLines(false);
    }
  };
  const startGuides = () => {
    if (guides) return applyGuides();
    if (cropDraft) applyCrop();
    setGuides([]);
    setGuideFit(null);
    void detectGuides();
  };
  /** Commit the fitted correction, if any, and close the guides. */
  const applyGuides = () => {
    if (store.getState().live !== committed) commit(undefined, 'Perspective');
    setGuides(null);
  };
  const cancelGuides = () => {
    if (store.getState().live !== committed) store.setLive(committed);
    setGuides(null);
  };
  /**
   * Fit the correction to the selected guides (`lines`, or those being edited, or else
   * the detected ones). While guides are edited, it's a live change, applied with them;
   * otherwise it's committed.
   */
  const fitPerspective = async (mode: PerspectiveFit, lines = guides) => {
    setFittingPerspective(mode);
    try {
      const source =
        lines ?? (await backend.detectLines(params, Math.min(job.width, GUIDES_MAX), Math.min(job.height, GUIDES_MAX)));
      const fit = await backend.fitPerspective(
        params,
        source.filter((l) => l.selected),
        mode,
      );
      if (!fit) {
        const kind = mode === 'both' ? 'vertical or horizontal' : mode;
        throw new Error(`It needs ${kind} guides: select or draw some.`);
      }
      const round = (v: number, k: number) => Math.round(v * k) / k;
      const correction = {
        angle: round(fit.angle, 100),
        vertical: round(fit.vertical, 100),
        horizontal: round(fit.horizontal, 100),
        shear: round(fit.shear, 1000),
      };
      // The recipe may have changed while fitting.
      const next = updateModule(store.getState().live, 'geometry', { enabled: true, params: correction });
      if (lines) {
        store.setLive(next);
        setGuideFit(mode);
      } else commit(next, `Perspective (${mode})`);
    } catch (err) {
      toaster.create({
        type: 'error',
        title: 'Perspective fit failed',
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setFittingPerspective(null);
    }
  };
  const changeGuides = (lines: GuideLine[]) => {
    setGuides(lines);
    if (guideFit) void fitPerspective(guideFit, lines);
  };
  const selectGuides = (selected: boolean) => guides && changeGuides(guides.map((l) => ({ ...l, selected })));

  // ── Actions ──
  const exportSetup = useExportSetup();
  const exportPhoto = async (settings: ExportSettings) => {
    setExporting(true);
    exportSetup.remember(settings);
    try {
      const format = EXPORT_FORMATS.find((f) => f.value === settings.format)!;
      const blob = await backend.export(params, exportOptions(settings), exportInfo.metadata);
      saveBlob(blob, exportFilename(settings.filename, exportInfo.filename, format.extension));
    } catch (err) {
      toaster.create({
        type: 'error',
        title: 'Export failed',
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setExporting(false);
    }
  };

  const [exportOpen, setExportOpen] = useState(false);
  const exportImageSize = useMemo(
    () => (frame ? { width: frame.sourceWidth, height: frame.sourceHeight } : null),
    [frame?.sourceWidth, frame?.sourceHeight],
  ); // eslint-disable-line react-hooks/exhaustive-deps
  const openExport = useStableCallback(() => setExportOpen(true));
  const closeExport = useStableCallback(() => setExportOpen(false));
  const onExport = useStableCallback((settings: ExportSettings) => void exportPhoto(settings));

  // Filmic auto-tune, measured on the image with the current crop.
  const autoTuneFilmic = async () => {
    setAutoTuning(true);
    try {
      // At a fixed size, like the auto-tunes of presets (`autoTune.ts`): the result
      // doesn't depend on the zoom or the window.
      const result = await backend.autoTuneFilmic(params, AUTO_TUNE_SIZE, AUTO_TUNE_SIZE);
      if (!result) throw new Error('Nothing to measure');
      commit(
        updateModule(params, 'filmic', {
          params: {
            whiteExposure: roundFilmicExposure(result.white),
            blackExposure: roundFilmicExposure(result.black),
          },
        }),
      );
    } catch (err) {
      toaster.create({
        type: 'error',
        title: 'Auto-tune failed',
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setAutoTuning(false);
    }
  };

  // Every auto-tune at once (A): each enabled filmic and tone curve instance, in pipeline
  // order (`resolveAutoTunes`), as one history entry.
  const autoTuneAll = () => {
    if (autoTuning || fittingTone) return;
    const p = {
      ...params,
      modules: params.modules.map((m) =>
        m.enabled && AUTO_TUNE_KINDS.includes(m.kind) ? { ...m, autoTune: true as const } : m,
      ),
    };
    if (hasPendingAutoTune(p)) void commitTuned(p, 'Auto-tune');
  };

  // Colour calibration's illuminant detection, measured on the full-size preview.
  const detectIlluminant = async (id: string, method: IlluminantDetection) => {
    setDetecting(id);
    try {
      const xy = await backend.detectIlluminant(params, id, method, job.width, job.height);
      if (!xy) throw new Error('Nothing to measure');
      commit(updateInstance(params, 'colorCalibration', id, { enabled: true, params: illuminantFromXy(xy) }));
    } catch (err) {
      toaster.create({
        type: 'error',
        title: 'Detection failed',
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setDetecting(null);
    }
  };

  // Tone curves show what they read on their input. It's measured again (on the
  // full-size preview, like the detections above) once commits settle, for each enabled
  // instance whose input may have changed: the modules before it, the shapes, what it
  // reads and the size. The worker renders one thing at a time, so not while dragging.
  const toneKeys = useMemo(
    () =>
      committed.modules.flatMap((m, i) =>
        m.kind === 'toneCurve' && m.enabled
          ? [
              [
                m.id,
                JSON.stringify([
                  committed.modules.slice(0, i),
                  committed.shapes,
                  m.params.channels,
                  m.params.preserveColors,
                  // Preserving detail, it reads its mask.
                  m.params.preserveDetail,
                  m.params.smoothing,
                  m.params.edgeRefinement,
                  job.width,
                  job.height,
                ]),
              ] as const,
            ]
          : [],
      ),
    [committed, job.width, job.height],
  );
  const toneMeasured = useRef(new Map<string, string>());
  useEffect(() => {
    if (live) return;
    const stale = toneKeys.filter(([id, key]) => toneMeasured.current.get(id) !== key);
    if (!stale.length) return;
    const timer = setTimeout(async () => {
      for (const [id, key] of stale) {
        toneMeasured.current.set(id, key);
        const input = await backend.toneCurveInput(committed, id, job.width, job.height).catch(() => null);
        setToneInputs(({ [id]: _, ...rest }) => (input ? { ...rest, [id]: input } : rest));
      }
    }, TONE_MEASURE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [toneKeys, live]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fit tone curve instance `id`'s nodes to its input (adding the instance if needed).
  const fitToneCurve = async (id: string) => {
    setFittingTone(id);
    try {
      const recipe = updateInstance(params, 'toneCurve', id, { enabled: true });
      // At a fixed size, like the auto-tunes of presets (`autoTune.ts`).
      const input = await backend.toneCurveInput(recipe, id, AUTO_TUNE_SIZE, AUTO_TUNE_SIZE);
      if (!input) throw new Error('Nothing to measure');
      setToneInputs((t) => ({ ...t, [id]: input }));
      const range = input.fit.map(roundToneRange);
      commit(updateInstance(recipe, 'toneCurve', id, { params: { range } }));
    } catch (err) {
      toaster.create({
        type: 'error',
        title: 'Fitting failed',
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setFittingTone(null);
    }
  };

  // ── Multiple exposure ──
  const missingExposures = useMissingExposures(backend, params);
  const onChooseExposure = useStableCallback(
    (current: PhotoRef | null): Promise<PhotoRef | null> => chooseExposure?.(current) ?? Promise.resolve(null),
  );

  // ── LUTs ──
  const luts = useLutLibrary();
  const missingLuts = useMissingLuts();
  const onAddLut = useStableCallback(async (file: File): Promise<LutChoice | null> => {
    try {
      const parsed = await backend.parseLut(await file.arrayBuffer());
      const lut = await luts.add(parsed, file.name.replace(/\.[^.]+$/, ''));
      toaster.create({ type: 'success', title: `Added LUT “${lut.name}”` });
      return lut;
    } catch (err) {
      toaster.create({
        type: 'error',
        title: `Could not add ${file.name}`,
        description: err instanceof Error ? err.message : undefined,
      });
      return null;
    }
  });
  const onRemoveLut = useStableCallback((lut: LutChoice) =>
    luts.remove(lut).then(
      () => toaster.create({ type: 'info', title: `Removed LUT “${lut.name}”` }),
      (err: unknown) =>
        toaster.create({
          type: 'error',
          title: 'Could not remove the LUT',
          description: err instanceof Error ? err.message : undefined,
        }),
    ),
  );

  // ── Presets and styles ──
  const presets = usePresetLibrary();
  // Menu thumbnails of presets and styles, by recipe.
  const thumbnails = useThumbnailCache(backend);
  const [creatingStyle, setCreatingStyle] = useState(false);
  // The highlighted style is shown on the image, like module presets.
  const stylePreview = useRecipePreview(
    () => store.getState().live,
    (p) => store.setLive(p),
  );
  const onPreviewStyle = useStableCallback((style: Style | 'paste' | null, appendAll: boolean) => {
    if (style !== 'paste')
      return stylePreview.preview(style && ((p) => forPhoto(applyStyle(p, style.payload, appendAll), metadata)));
    const clip = readClipboard();
    stylePreview.preview(clip && ((p) => forPhoto(pasteEdit(clip, appendAll).apply(p), metadata)));
  });
  const onApplyStyle = useStableCallback((style: Style, appendAll: boolean) => {
    setCropDraft(null);
    setGuides(null);
    const before = stylePreview.end();
    commit(
      forPhoto(applyStyle(before, style.payload, appendAll), metadata),
      `Style: ${style.name}${appendAll ? ' (appended)' : ''}`,
    );
  });
  const onStyleRecipe = useStableCallback((style: Style) =>
    forPhoto(applyStyle(stylePreview.before(), style.payload, false), metadata),
  );
  const onCreateStyle = useStableCallback(() => setCreatingStyle(true));

  // ── Copy and paste (roadmap 8.6) ──
  const clipboard = useClipboard();
  const [copying, setCopying] = useState(false);
  const copy = (selection: StyleSelection) => {
    const n = copyEdits(store.getState().live, selection, sourceName(filename));
    toaster.create({ type: 'info', title: n === 1 ? 'Copied 1 module' : `Copied ${n} modules`, duration: 2500 });
  };
  /** Copy what was picked last time (Ctrl+C). */
  const copyLast = () => copy(lastSelection(store.getState().live));
  const onCopyPicked = useStableCallback((selection: StyleSelection) => {
    rememberPick(store.getState().live, selection);
    copy(selection);
  });
  const onOpenCopy = useStableCallback(() => setCopying(true));
  const onPaste = useStableCallback((appendAll: boolean) => {
    const clip = readClipboard();
    if (!clip) {
      toaster.create({
        type: 'info',
        title: 'Nothing copied yet',
        description: `Copy settings with ${commandLabel('Ctrl+C')}`,
        duration: 2500,
      });
      return;
    }
    setCropDraft(null);
    setGuides(null);
    const edit = pasteEdit(clip, appendAll);
    commit(forPhoto(edit.apply(stylePreview.end()), metadata), edit.label);
  });

  const stylesNode = useMemo(
    () =>
      presets.save && (
        <StyleMenu
          styles={presets.styles}
          paste={clipboard?.source ?? null}
          onApply={onApplyStyle}
          onPreview={onPreviewStyle}
          onEndPreview={stylePreview.end}
          recipeFor={onStyleRecipe}
          onCreate={onCreateStyle}
          onRename={presets.rename}
          onDelete={presets.remove}
          onCopy={onOpenCopy}
          onPaste={onPaste}
        />
      ),
    [presets.styles, !!presets.save, clipboard?.source], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // The module panel is memoised: its handlers must keep their identity.
  const onLiveChange = useStableCallback((p: EditParams) => store.setLive(p));
  const onPanelCommit = useStableCallback(commit);
  const onAspectChange = useStableCallback(changeAspect);
  const onCustomAspectChange = useStableCallback(changeCustomAspect);
  const onFlipAspect = useStableCallback(flipAspect);
  const onStartCrop = useStableCallback(startCrop);
  const onStartGuides = useStableCallback(startGuides);
  const onFitPerspective = useStableCallback((mode: PerspectiveFit) => void fitPerspective(mode));
  const onGuidesChange = useStableCallback(changeGuides);
  const onAutoTuneFilmic = useStableCallback(() => void autoTuneFilmic());
  const onDetectIlluminant = useStableCallback(
    (id: string, method: IlluminantDetection) => void detectIlluminant(id, method),
  );
  const onFitToneCurve = useStableCallback((id: string) => void fitToneCurve(id));
  const onToneView = useStableCallback((view: ToneCurveView | null) => {
    setToneView(view);
    if (view) setRangeView(null);
    if (view && shapeUi.maskOverlay) setShapeUi((u) => ({ ...u, maskOverlay: null }));
  });
  const onRangeView = useStableCallback((view: ToneRangeView | null) => {
    setRangeView(view);
    if (view) setToneView(null);
    if (view && shapeUi.maskOverlay) setShapeUi((u) => ({ ...u, maskOverlay: null }));
  });
  const onShapeUi = useStableCallback((patch: Partial<ShapeUi>) => setShapeUi((u) => ({ ...u, ...patch })));
  const onShapeCommit = useStableCallback((p: EditParams, label: string) => commit(p, label));
  // Shapes are drawn over the image, unless it shows something else (crop, before).
  // The pipette's clicks pin samples: shapes aren't edited meanwhile.
  const pinning = pipette && !framing && !comparing;
  const showShapes = shapeUi.editing && !framing && !comparing && !pipette;
  // A click (not a drag) on the image pins a sample there, or removes the pin under it.
  // On the zoom window: zoomed in, a press is a pan's start, which takes the pointer, and
  // its click then goes to the window rather than through the image.
  useEffect(() => {
    const win = zoomWindow.current;
    const el = stage.current;
    if (!win || !el || !pinning || !mapping) return;
    let down: [number, number] | null = null;
    const press = (e: PointerEvent) => void (down = [e.clientX, e.clientY]);
    const click = (e: MouseEvent) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
      const r = el.getBoundingClientRect();
      const [u, v] = [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
      if (u < 0 || u >= 1 || v < 0 || v >= 1) return;
      const hit = pinPlaces.findIndex(([pu, pv]) => Math.hypot((pu - u) * r.width, (pv - v) * r.height) < 9);
      setPins((ps) =>
        hit >= 0 ? ps.filter((_, i) => i !== hit) : ps.length < MAX_PINS ? [...ps, toSensor(mapping, u, v)] : ps,
      );
    };
    win.addEventListener('pointerdown', press, true);
    win.addEventListener('click', click, true);
    return () => {
      win.removeEventListener('pointerdown', press, true);
      win.removeEventListener('click', click, true);
    };
  }, [pinning, mapping, pinPlaces]);

  // Keyboard shortcuts.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      // An open menu or dialog closes on Esc (in the capture phase): that's all this press does.
      if (e.key === 'Escape' && e.defaultPrevented) return;
      // The export and copy dialogs are modal: the shortcuts would act on the photo behind them.
      if (exportOpen || copying) return;
      const field =
        e.target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) ? e.target : null;
      // Esc leaves a field first (it may also be closing a native dropdown), except a
      // module's switch: it keeps the focus after a click, with nothing to show for it.
      const toggle = field instanceof HTMLInputElement && field.type === 'checkbox';
      if (field && !(toggle && e.key === 'Escape')) {
        if (e.key === 'Escape') field.blur();
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && key === 'z' && !e.shiftKey) goto(history.end - 1);
      else if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) goto(history.end + 1);
      else if (mod && key === 's') autosave.flush();
      else if (mod && key === 'e' && !exporting) setExportOpen(true);
      // Copy settings, unless there's text selected to copy.
      else if (mod && key === 'c' && e.shiftKey) setCopying(true);
      else if (mod && key === 'c' && !window.getSelection()?.toString()) copyLast();
      else if (mod && key === 'v') onPaste(e.shiftKey);
      else if (!mod && key === '\\') setComparing(true);
      else if (!mod && key === 'y') setCompareOn((on) => !on);
      else if (!mod && key === 'c') startCrop();
      else if (!mod && key === 'a' && !e.shiftKey && !e.altKey) autoTuneAll();
      else if (mod && key === 'b') setAssessment((a) => !a);
      else if (!mod && key === 'o' && e.shiftKey) setClipping({ sensor: !clipping.sensor });
      else if (!mod && key === 'o') setClipping({ display: !clipping.display });
      else if (!mod && key === 'i' && !e.shiftKey && !e.altKey) setPipette((p) => !p);
      else if (key === 'escape' && pipette) setPipette(false);
      else if (key === 'enter' && cropDraft) applyCrop();
      else if (key === 'escape' && cropDraft) setCropDraft(null);
      else if (key === 'enter' && guides) applyGuides();
      else if (key === 'escape' && guides) cancelGuides();
      else if (key === 'escape' && compareOn) setCompareOn(false);
      // Not on key repeat, so that holding Esc doesn't go past a menu it closes, and not
      // during an export or auto-tune, which leaving would abort.
      else if (key === 'escape' && onBack && !e.repeat && !exporting && !autoTuning) {
        // Its undo would have nothing to apply to anymore.
        dismissUndo();
        store.commit();
        onBack();
      } else return;
      e.preventDefault();
    };
    const up = (e: KeyboardEvent) => e.key === '\\' && setComparing(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  });

  const onToggleCompare = useStableCallback(() => setCompareOn((on) => !on));
  const onCompareTarget = useStableCallback((target: CompareTarget) => {
    setCompareTarget(target);
    setCompareOn(true);
  });
  const compareNode = useMemo(
    () => (
      <CompareMenu
        on={compareOn}
        layout={compareLayout}
        target={compareTarget}
        entries={history.entries}
        versions={otherVersions}
        onToggle={onToggleCompare}
        onLayout={setCompareLayout}
        onTarget={onCompareTarget}
      />
    ),
    [compareOn, compareLayout, compareTarget, history.entries, otherVersions], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // The entry compared with: off again.
  const onCompareEntry = useStableCallback((seq: number) =>
    compareOn && compareTarget.kind === 'history' && compareTarget.seq === seq
      ? setCompareOn(false)
      : onCompareTarget({ kind: 'history', seq }),
  );
  const compareLabel = targetLabel(compareTarget, history.entries, otherVersions);
  const comparedSeq = compareOn && compareTarget.kind === 'history' ? compareTarget.seq : null;

  const { entries, end } = history;
  const versionsNode = useMemo(() => versions?.(autosave.whenSaved), [versions, autosave.whenSaved]);
  const actionsNode = useMemo(() => actions?.({ entries, end }), [actions, entries, end]);
  const saveState = useMemo(
    () => save && { status: autosave.status, retry: autosave.flush },
    [!!save, autosave.status, autosave.flush],
  ); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <SampleContext.Provider value={samples}>
      <ThumbnailContext.Provider value={thumbnails}>
        <Flex h="full" minH="0">
          <Flex
            ref={sidebar}
            {...ZEN_HIDE}
            as="aside"
            direction="column"
            w="56"
            flexShrink={0}
            borderRightWidth="1px"
            bg="bg.panel"
            minH="0"
            css={NO_SELECT}
          >
            <ScopePanel
              settings={scopes}
              onChange={setScopes}
              width={scopeWidth}
              height={scopeCssHeight}
              canvasRef={scopeCanvas}
            />
            <Box flex="1" minH="0">
              <HistoryPanel
                original={original}
                entries={history.entries}
                end={history.end}
                open={historyOpen}
                onToggle={toggleHistory}
                onSelect={onSelectEntry}
                onUndo={onUndo}
                onRedo={onRedo}
                onCompress={onCompress}
                onReset={onReset}
                compared={comparedSeq}
                onCompare={onCompareEntry}
              />
            </Box>
            <ConfirmDialog
              text={
                confirmReset
                  ? {
                      title: 'Reset history?',
                      body: 'Every edit is dropped: the history starts again from the original and the automatic recipe, as when the photo was imported.',
                    }
                  : null
              }
              confirm="Reset history"
              onConfirm={() => {
                setConfirmReset(false);
                resetHistory();
              }}
              onClose={() => setConfirmReset(false)}
            />
          </Flex>
          <Flex direction="column" flex="1" minW="0">
            <Toolbar
              filename={filename}
              metadata={metadata}
              versions={versionsNode}
              styles={stylesNode}
              compare={compareNode}
              exporting={exporting}
              actions={actionsNode}
              onExport={openExport}
            />
            <ImportNotice edits={importedEdits} metadata={metadata} label={history.entries[history.end - 1]?.label} />
            <ExportDialog
              open={exportOpen}
              source={canvas}
              imageSize={exportImageSize}
              initial={exportSetup.initial}
              presets={exportSetup.presets}
              filenameFields={exportInfo.filename}
              onClose={closeExport}
              onExport={onExport}
              onSavePreset={exportSetup.savePreset}
              onDeletePreset={exportSetup.deletePreset}
            />

            <Center ref={viewport} flex="1" minH="0" bg="canvas" position="relative" overflow="hidden">
              {/* The edited image's pane, and the compared image's (roadmap M5): over it in a split
                  view, beside it otherwise. */}
              <Grid
                position="absolute"
                inset="0"
                gap={`${COMPARE_GAP}px`}
                templateColumns={sideBySide ? '1fr 1fr' : '1fr'}
                templateRows="100%"
              >
                <Center
                  position="relative"
                  minW="0"
                  minH="0"
                  overflow="hidden"
                  gridRow="1"
                  gridColumn={sideBySide ? 2 : 1}
                >
                  {/* Always mounted: it holds the zoom's event listeners. */}
                  <Box
                    ref={zoomWindow}
                    position={assessment ? 'relative' : 'absolute'}
                    inset={assessment ? undefined : '0'}
                    boxSizing="content-box"
                    overflow="hidden"
                    touchAction="none"
                    borderWidth={`${frameWidth}px`}
                    borderStyle="solid"
                    borderColor={frameWidth ? 'white' : 'transparent'}
                    visibility={frame ? 'visible' : 'hidden'}
                    style={assessment ? { width: fitWidth, height: fitHeight } : undefined}
                  >
                    {/* The fitted image, moved and scaled by the zoom (its transform is set by `useZoom`). */}
                    <Box
                      ref={stage}
                      position="absolute"
                      top="0"
                      left="0"
                      lineHeight="0"
                      transformOrigin="0 0"
                      cursor={pinning ? 'crosshair' : undefined}
                      // The pipette's clicks pin samples: a double click isn't a zoom then.
                      data-no-zoom={pinning || undefined}
                      style={{ width: fitWidth, height: fitHeight }}
                    >
                      <canvas
                        ref={canvas}
                        data-image="edited"
                        style={{ width: '100%', height: '100%', display: 'block' }}
                      />
                      <canvas ref={regionCanvas} style={regionStyle(region, regionFrame)} />
                      {showShapes && frame && layout && (
                        <ShapeOverlay
                          params={params}
                          mapping={frame.mapping}
                          width={fitWidth}
                          height={fitHeight}
                          zoom={zoom ? Math.max(1, zoom.scale / layout.fitScale) : 1}
                          ui={shapeUi}
                          onUi={onShapeUi}
                          onChange={onLiveChange}
                          onCommit={onShapeCommit}
                        />
                      )}
                      {guides && !comparing && frame && layout && (
                        <GuideOverlay
                          lines={guides}
                          mapping={frame.mapping}
                          width={fitWidth}
                          height={fitHeight}
                          zoom={zoom ? Math.max(1, zoom.scale / layout.fitScale) : 1}
                          onChange={onGuidesChange}
                        />
                      )}
                      {!framing && !comparing && layout && (
                        <PinMarkers places={pinPlaces} zoom={zoom ? Math.max(1, zoom.scale / layout.fitScale) : 1} />
                      )}
                      {cropDraft && !comparing && (
                        <CropOverlay
                          rect={cropDraft}
                          aspect={aspectRatio(aspect, originalAspect)}
                          frameAspect={frameAspect}
                          onChange={setCropDraft}
                        />
                      )}
                    </Box>
                  </Box>
                  {sideBySide && <PaneLabel>Current</PaneLabel>}
                </Center>
                {/* Always mounted, like the edited image's: side by side, it holds the zoom's
                    listeners too. Split, the pointer goes through to the edited image. */}
                <Center
                  position="relative"
                  minW="0"
                  minH="0"
                  overflow="hidden"
                  gridRow="1"
                  gridColumn="1"
                  display={comparison ? 'flex' : 'none'}
                  pointerEvents={sideBySide ? undefined : 'none'}
                >
                  <Box
                    ref={compareWindow}
                    position={assessment ? 'relative' : 'absolute'}
                    inset={assessment ? undefined : '0'}
                    boxSizing="content-box"
                    overflow="hidden"
                    touchAction="none"
                    borderWidth={`${frameWidth}px`}
                    borderStyle="solid"
                    borderColor={frameWidth ? 'white' : 'transparent'}
                    visibility={compareShown ? 'visible' : 'hidden'}
                    style={{
                      ...(assessment ? { width: fitWidth, height: fitHeight } : undefined),
                      // Split: only left of the divider (in the window's border box).
                      clipPath: sideBySide ? undefined : splitClip(split, pane.width, compareWindowWidth),
                    }}
                  >
                    <Box
                      ref={compareStage}
                      position="absolute"
                      top="0"
                      left="0"
                      lineHeight="0"
                      transformOrigin="0 0"
                      style={{ width: fitWidth, height: fitHeight }}
                    >
                      <canvas
                        ref={compareCanvas}
                        data-image="compared"
                        style={{ width: '100%', height: '100%', display: 'block' }}
                      />
                      <canvas ref={compareRegionCanvas} style={regionStyle(compareRegion, compareRegionFrame)} />
                      {/* The edited image's shapes, the same on both: the framing is the same. */}
                      {comparison && showShapes && frame && layout && (
                        <div inert style={{ position: 'absolute', inset: 0 }}>
                          <ShapeOverlay
                            readOnly
                            params={params}
                            mapping={frame.mapping}
                            width={fitWidth}
                            height={fitHeight}
                            zoom={zoom ? Math.max(1, zoom.scale / layout.fitScale) : 1}
                            ui={shapeUi}
                            onUi={onShapeUi}
                            onChange={onLiveChange}
                            onCommit={onShapeCommit}
                          />
                        </div>
                      )}
                    </Box>
                  </Box>
                  {sideBySide && <PaneLabel>{compareLabel}</PaneLabel>}
                </Center>
                {comparison && !sideBySide && frame && (
                  <Center position="relative" minW="0" minH="0" gridRow="1" gridColumn="1" pointerEvents="none">
                    <SplitDivider split={split} onChange={setSplit} before={compareLabel} />
                  </Center>
                )}
              </Grid>
              {/* Over the image, not under it: pinning the first sample doesn't move the image. */}
              {pins.length > 0 && !framing && (
                <PinnedSamples
                  count={pins.length}
                  onRemove={(i) => setPins((ps) => ps.filter((_, j) => j !== i))}
                  // Done sampling: the pipette goes off too.
                  onClear={() => {
                    setPins([]);
                    setPipette(false);
                  }}
                />
              )}
              {!frame && <Spinner color="orange.solid" size="lg" position="absolute" />}
              {frame && (
                <RenderSpinner
                  busy={zoom ? regionPending || compareRegionPending : pending || comparePending}
                  frame={zoom ? regionFrame : frame}
                />
              )}
              {error && (
                <Text position="absolute" bottom="3" color="fg.error" textStyle="sm">
                  {error}
                </Text>
              )}
              {showShapes && shapeUi.tool !== 'select' && (
                <Text
                  {...ZEN_HIDE}
                  position="absolute"
                  bottom="4"
                  bg="bg.panel"
                  px="3"
                  py="1.5"
                  borderRadius="md"
                  boxShadow="lg"
                  textStyle="xs"
                  color="fg.muted"
                  pointerEvents="none"
                >
                  {shapeUi.tool === 'path'
                    ? 'Click to add nodes, drag for curves · Enter or the first node to close'
                    : shapeUi.tool === 'brush'
                      ? 'Paint a stroke'
                      : shapeUi.tool === 'gradient'
                        ? 'Drag from where it applies fully to where it stops'
                        : `Click or drag to add a ${shapeUi.target === 'mask' ? 'shape' : 'spot'}`}
                  {' · Middle-drag to pan · Esc to stop'}
                </Text>
              )}
              {guides && (
                <HStack
                  {...ZEN_HIDE}
                  position="absolute"
                  bottom="4"
                  bg="bg.panel"
                  p="2"
                  borderRadius="md"
                  boxShadow="lg"
                >
                  <Text textStyle="xs" color="fg.muted" px="2">
                    {detectingLines
                      ? 'Looking for lines…'
                      : `${guides.filter((l) => l.selected).length} of ${guides.length} selected · Click to select · Drag to draw · Right-click to remove`}
                  </Text>
                  <Button size="xs" variant="ghost" disabled={!guides.length} onClick={() => selectGuides(true)}>
                    All
                  </Button>
                  <Button size="xs" variant="ghost" disabled={!guides.length} onClick={() => selectGuides(false)}>
                    None
                  </Button>
                  <Button size="xs" variant="ghost" disabled={!guides.length} onClick={() => changeGuides([])}>
                    Clear
                  </Button>
                  <Button size="xs" variant="ghost" loading={detectingLines} onClick={() => void detectGuides()}>
                    Detect
                  </Button>
                  <Button size="xs" variant="ghost" onClick={cancelGuides}>
                    <X /> Cancel
                  </Button>
                  <Button size="xs" colorPalette="orange" onClick={applyGuides}>
                    <Check /> Apply
                  </Button>
                </HStack>
              )}
              {cropDraft && (
                <HStack
                  {...ZEN_HIDE}
                  position="absolute"
                  bottom="4"
                  bg="bg.panel"
                  p="2"
                  borderRadius="md"
                  boxShadow="lg"
                >
                  <Text textStyle="xs" color="fg.muted" px="2">
                    Drag to crop · Enter to apply · Esc to cancel
                  </Text>
                  <Button size="xs" variant="ghost" onClick={() => setCropDraft(null)}>
                    <X /> Cancel
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => setCropDraft(FULL_CROP)}>
                    Reset
                  </Button>
                  <Button size="xs" colorPalette="orange" onClick={applyCrop}>
                    <Check /> Apply
                  </Button>
                </HStack>
              )}
            </Center>
            <StatusBar
              pipette={pipette}
              onPipette={() => setPipette((p) => !p)}
              save={saveState}
              ms={(region ? regionFrame?.ms : frame?.ms) ?? null}
              zoom={zoom ? zoom.scale : null}
              fitScale={layout?.fitScale ?? 1}
              onZoom={cropDraft ? undefined : zoomTo}
              clipping={clipping}
              onClippingChange={setClipping}
              assessment={assessment}
              onAssessmentChange={setAssessment}
              zen={<ZenButton state={zen.state} onStart={zen.start} onEnd={zen.end} />}
            />
          </Flex>

          <Box
            ref={spotlight.aside}
            {...ZEN_HIDE}
            as="aside"
            w="80"
            flexShrink={0}
            borderLeftWidth="1px"
            bg="bg"
            overflowY="auto"
            // Not anchored by the browser: the spotlight keeps the module in place itself.
            overflowAnchor="none"
            css={NO_SELECT}
            onScroll={spotlight.onScroll}
          >
            {spotlight.open && (
              <Box position="sticky" top="0" zIndex="1">
                <Spotlight
                  params={params}
                  imageFormat={metadata.imageFormat ?? null}
                  panel={spotlight.panel}
                  onFocus={spotlight.setFocus}
                  onClose={spotlight.onClose}
                />
              </Box>
            )}
            <div ref={spotlight.above} data-space="above" />
            <Box ref={spotlight.panel}>
              <ModulePanel
                only={spotlight.focus}
                params={params}
                denoise={denoise}
                lensCorrection={metadata.lensCorrection ?? null}
                lensShot={lensShot}
                asShotIlluminant={metadata.asShotIlluminant ?? null}
                imageFormat={metadata.imageFormat ?? null}
                original={original}
                onChange={onLiveChange}
                onCommit={onPanelCommit}
                presets={presets.modulePresets}
                onSavePreset={presets.save}
                onRenamePreset={presets.rename}
                onDeletePreset={presets.remove}
                luts={luts}
                missingLuts={missingLuts}
                onAddLut={onAddLut}
                onChooseExposure={onChooseExposure}
                missingExposures={missingExposures}
                onRenameLut={luts.rename}
                onRemoveLut={onRemoveLut}
                cropping={!!cropDraft}
                aspect={aspect}
                onAspectChange={onAspectChange}
                onCustomAspectChange={onCustomAspectChange}
                onFlipAspect={onFlipAspect}
                onStartCrop={onStartCrop}
                guides={guides !== null}
                onStartGuides={onStartGuides}
                onFitPerspective={onFitPerspective}
                fittingPerspective={fittingPerspective}
                onAutoTuneFilmic={onAutoTuneFilmic}
                autoTuning={autoTuning}
                onDetectIlluminant={onDetectIlluminant}
                detecting={detecting}
                toneInputs={toneInputs}
                onFitToneCurve={onFitToneCurve}
                fittingTone={fittingTone}
                toneView={toneOverlay}
                onToneView={onToneView}
                rangeView={rangeOverlay}
                onRangeView={onRangeView}
                shapeUi={shapeUi}
                onShapeUi={onShapeUi}
              />
            </Box>
            <div ref={spotlight.below} data-space="below" />
          </Box>
          {copying && (
            <CopyEditsDialog
              recipe={store.getState().live}
              initial={lastSelection(store.getState().live)}
              onClose={() => setCopying(false)}
              onCopy={onCopyPicked}
            />
          )}
          {creatingStyle && presets.save && (
            <CreateStyleDialog
              recipe={params}
              existing={presets.styles}
              onClose={() => setCreatingStyle(false)}
              onSave={presets.save}
            />
          )}
        </Flex>
      </ThumbnailContext.Provider>
    </SampleContext.Provider>
  );
}
