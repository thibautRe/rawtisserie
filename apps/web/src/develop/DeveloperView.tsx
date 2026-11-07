import { Box, Button, Center, Flex, HStack, IconButton, Spinner, Stack, Text } from '@chakra-ui/react';
import {
  type CropRect,
  EXPORT_FORMATS,
  type EditParams,
  type ExportSettings,
  type PhotoMetadata,
  type Style,
  type StyleMode,
  applyStyle,
  defaultEditParams,
  exportFilename,
  exportOptions,
  findModule,
  illuminantFromXy,
  updateInstance,
  updateModule,
} from '@rawtisserie/pipeline';
import { Check, Download, Redo2, SplitSquareHorizontal, Undo2, X } from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppMenu } from '../components/AppMenu.tsx';
import { toaster } from '../components/toaster.tsx';
import { formatAperture, formatExposureTime, formatFocal, formatIso } from '../lib/format.ts';
import { type CropAspect, FREE_ASPECT, aspectRatio, constrainAspect, flipCrop, isPortrait } from './aspect.ts';
import { CropOverlay } from './CropOverlay.tsx';
import { type HistorySnapshot, HistoryStore } from './history.ts';
import { HistoryPanel } from './HistoryPanel.tsx';
import { ModulePanel } from './ModulePanel.tsx';
import { CreateStyleDialog, StyleMenu, usePresetLibrary } from './presets.tsx';
import { type LutChoice, useLutLibrary, useMissingLuts } from './luts.ts';
import { useRecipePreview } from './preview.ts';
import { GuideOverlay } from './GuideOverlay.tsx';
import type { GuideLine, IlluminantDetection, PerspectiveFit, ToneCurveInput, ToneCurveView } from './protocol.ts';
import { DEFAULT_SHAPE_UI, type ShapeUi } from './retouch.ts';
import { ShapeOverlay } from './ShapeOverlay.tsx';
import type { Frame, RenderBackend } from './renderBackend.ts';
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
  /** Extra toolbar actions, given the current history. */
  actions?: (history: HistorySnapshot) => React.ReactNode;
  /** Shown next to the file name (the version switcher), given a way to wait for pending saves. */
  versions?: (whenSaved: () => Promise<void>) => React.ReactNode;
  /** Go back to where the photo was opened from (Esc). */
  onBack?: () => void;
}

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
  canUndo,
  canRedo,
  comparing,
  exporting,
  actions,
  onUndo,
  onRedo,
  onCompare,
  onExport,
}: {
  filename: string;
  metadata: PhotoMetadata;
  versions: React.ReactNode;
  /** The styles menu, with an account. */
  styles: React.ReactNode;
  canUndo: boolean;
  canRedo: boolean;
  comparing: boolean;
  exporting: boolean;
  actions: React.ReactNode;
  onUndo: () => void;
  onRedo: () => void;
  onCompare: (on: boolean) => void;
  /** Opens the export dialog. */
  onExport: () => void;
}) {
  const exif = [
    [metadata.make, metadata.model].filter(Boolean).join(' '),
    metadata.lensModel,
    formatFocal(metadata.focalLength),
    formatExposureTime(metadata.exposureTime),
    formatAperture(metadata.fNumber),
    formatIso(metadata.iso),
  ].filter(Boolean);

  return (
    <HStack px="3" py="2" borderBottomWidth="1px" gap="2">
      <AppMenu />
      <Stack gap="0" minW="0" flex="1">
        <HStack gap="1" minW="0">
          <Text fontWeight="semibold" truncate>
            {filename}
          </Text>
          {versions}
        </HStack>
        <Text textStyle="xs" color="fg.muted" truncate>
          {exif.join(' · ')}
        </Text>
      </Stack>
      <IconButton aria-label="Undo (Ctrl+Z)" size="sm" variant="ghost" disabled={!canUndo} onClick={onUndo}>
        <Undo2 />
      </IconButton>
      <IconButton aria-label="Redo (Ctrl+Shift+Z)" size="sm" variant="ghost" disabled={!canRedo} onClick={onRedo}>
        <Redo2 />
      </IconButton>
      {styles}
      <Button
        size="sm"
        variant={comparing ? 'solid' : 'ghost'}
        title="Hold to see the unedited image (or hold \)"
        onPointerDown={() => onCompare(true)}
        onPointerUp={() => onCompare(false)}
        onPointerLeave={() => onCompare(false)}
      >
        <SplitSquareHorizontal /> Before
      </Button>
      <Button size="sm" variant="outline" loading={exporting} loadingText="Exporting…" onClick={onExport}>
        <Download /> Export
      </Button>
      {actions}
    </HStack>
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
  actions,
  versions,
  onBack,
}: Props) {
  const [store] = useState(() => new HistoryStore(original, initialHistory));
  const history = useSyncExternalStore(store.subscribe, store.getState);
  const params = history.live;
  const committed = history.entries[history.end - 1]?.recipe ?? original;
  /** A live change (e.g. a slider being dragged) has not been committed yet. */
  const live = params !== committed;
  const autosave = useAutosave(store, revision, save);

  const [comparing, setComparing] = useState(false);
  // ISO 12646 colour assessment: a white frame around a smaller image on neutral grey.
  const [assessment, setAssessment] = useState(() => localStorage.getItem('developer.assessment') === '1');
  useEffect(() => localStorage.setItem('developer.assessment', assessment ? '1' : '0'), [assessment]);
  const [clipping, setClipping] = useClippingSettings();
  const [scopes, setScopes] = useScopeSettings();
  const [cropDraft, setCropDraft] = useState<CropRect | null>(null);
  // Perspective guides while they are edited (null otherwise): the whole corrected image
  // shows, and fits change the live recipe until applied.
  const [guides, setGuides] = useState<GuideLine[] | null>(null);
  const [detectingLines, setDetectingLines] = useState(false);
  // The last fit while editing guides: run again whenever they change.
  const [guideFit, setGuideFit] = useState<PerspectiveFit | null>(null);
  const [fittingPerspective, setFittingPerspective] = useState<PerspectiveFit | null>(null);
  const [aspect, setAspect] = useState<CropAspect>(FREE_ASPECT);
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
  useEffect(() => {
    if (shapeUi.maskOverlay) setToneView(null);
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
  const { view: zoom, zoomTo } = useZoom(zoomWindow, stage, zoomLayout, !cropDraft);
  /** Crop or guides: the image shows uncropped, without overlays. */
  const framing = cropDraft !== null || guides !== null;
  // Zoomed in, the fitted render is mostly hidden: it stays at the committed recipe
  // while a slider is dragged, so that only the visible region is rendered.
  const fitParams = zoom && live ? committed : params;
  const withView = (p: EditParams) => {
    if (comparing) return defaultEditParams;
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
  const { margin, frameWidth } = assessmentLayout(size, assessment);
  const job = useMemo(() => {
    const inset = 2 * (margin + frameWidth);
    const width = Math.min(MAX_PREVIEW, Math.floor((size.width - inset) * dpr));
    const height = Math.min(MAX_PREVIEW, Math.floor((size.height - inset) * dpr));
    const scale = draft ? Math.min(1, Math.sqrt(DRAFT_PIXELS / Math.max(1, width * height))) : 1;
    const overlays = {
      display: clipping.display ? { mode: clipping.mode } : null,
      sensor: clipping.sensor,
      stripes: clipping.zebra ? STRIPE_PX * dpr * scale : 0,
      mask: comparing || framing ? null : (maskOverlay?.id ?? null),
      maskView: maskOverlay ? { part: maskOverlay.part, values: maskOverlay.values } : undefined,
      toneCurve: comparing || framing ? null : toneOverlay,
    };
    return { params: fitEffective, width, height, scale, overlays, scope: scopeRequest };
  }, [
    fitEffective,
    size.width,
    size.height,
    dpr,
    draft,
    margin,
    frameWidth,
    clipping,
    scopeRequest,
    maskOverlay,
    toneOverlay,
  ]); // eslint-disable-line react-hooks/exhaustive-deps
  const { frame, error, pending } = useRenderLoop(backend, job);

  // The image is seen through a window: the viewport, or the inside of the ISO 12646
  // frame, which keeps its place and shape when zooming.
  const fitWidth = frame ? frame.fullWidth / dpr : 0;
  const fitHeight = frame ? frame.fullHeight / dpr : 0;
  zoomLayout.current = frame && {
    windowWidth: assessment ? fitWidth : size.width,
    windowHeight: assessment ? fitHeight : size.height,
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
    };
    return { params: effective, width, height, region, scale, overlays };
  }, [zoom, JSON.stringify(layout), effective, live, dpr, clipping, maskOverlay, toneOverlay]); // eslint-disable-line react-hooks/exhaustive-deps
  const { frame: regionFrame, pending: regionPending } = useRenderLoop(backend, regionJob);
  // A region left from an earlier zoom may show an older recipe: zooming in again waits
  // for a new one.
  const staleRegion = useRef<Frame | null>(null);
  if (!zoom) staleRegion.current = regionFrame;
  // A region of the same image (not of another crop, or of the unedited image).
  const region =
    zoom &&
    regionFrame &&
    regionFrame !== staleRegion.current &&
    frame &&
    regionFrame.sourceWidth === frame.sourceWidth &&
    regionFrame.sourceHeight === frame.sourceHeight
      ? regionFrame.placement
      : null;

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
  const canUndo = history.end > 0;
  const canRedo = history.end < history.entries.length;
  const onSelectEntry = useStableCallback(goto);
  const onCompress = useStableCallback(compress);
  const onUndo = useStableCallback(() => goto(history.end - 1));
  const onRedo = useStableCallback(() => goto(history.end + 1));

  // ── Crop ──
  const frameAspect = frame ? frame.fullWidth / frame.fullHeight : 1;
  const crop = findModule(params, 'geometry')?.params.crop ?? FULL_CROP;
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
    const ratio = aspectRatio(next, frameAspect);
    const base = rect ?? cropDraft;
    if (base) setCropDraft(constrainAspect(base, ratio, frameAspect));
    else if (ratio) setCropDraft(constrainAspect(crop, ratio, frameAspect));
  };
  // A preset keeps the crop's orientation; a typed ratio is taken as written.
  const changeAspect = (preset: string) =>
    setCropAspect({ ...aspect, preset, flipped: preset !== 'custom' && isPortrait(cropDraft ?? crop, frameAspect) });
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
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement('a'), {
        href: url,
        download: exportFilename(settings.filename, exportInfo.filename, format.extension),
      });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
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

  // Filmic auto-tune, measured on the full-size preview (with the current crop).
  const autoTuneFilmic = async () => {
    setAutoTuning(true);
    try {
      const result = await backend.autoTuneFilmic(params, job.width, job.height);
      if (!result) throw new Error('Nothing to measure');
      const round = (v: number) => Math.round(v * 100) / 100;
      commit(
        updateModule(params, 'filmic', {
          params: { whiteExposure: round(result.white), blackExposure: round(result.black) },
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
      const input = await backend.toneCurveInput(recipe, id, job.width, job.height);
      if (!input) throw new Error('Nothing to measure');
      setToneInputs((t) => ({ ...t, [id]: input }));
      const range = input.fit.map((v) => Math.round(v * 10) / 10);
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
  const [creatingStyle, setCreatingStyle] = useState(false);
  // The highlighted style is shown on the image, like module presets.
  const stylePreview = useRecipePreview(
    () => store.getState().live,
    (p) => store.setLive(p),
  );
  const onPreviewStyle = useStableCallback((style: Style | null, mode: StyleMode) =>
    stylePreview.preview(style && ((p) => applyStyle(p, style.payload, mode))),
  );
  const onApplyStyle = useStableCallback((style: Style, mode: StyleMode) => {
    setCropDraft(null);
    setGuides(null);
    const before = stylePreview.end();
    commit(applyStyle(before, style.payload, mode), `Style: ${style.name}${mode === 'append' ? ' (appended)' : ''}`);
  });
  const onCreateStyle = useStableCallback(() => setCreatingStyle(true));
  const stylesNode = useMemo(
    () =>
      presets.save && (
        <StyleMenu
          styles={presets.styles}
          onApply={onApplyStyle}
          onPreview={onPreviewStyle}
          onEndPreview={stylePreview.end}
          onCreate={onCreateStyle}
          onDelete={presets.remove}
        />
      ),
    [presets.styles, !!presets.save], // eslint-disable-line react-hooks/exhaustive-deps
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
    if (view && shapeUi.maskOverlay) setShapeUi((u) => ({ ...u, maskOverlay: null }));
  });
  const onShapeUi = useStableCallback((patch: Partial<ShapeUi>) => setShapeUi((u) => ({ ...u, ...patch })));
  const onShapeCommit = useStableCallback((p: EditParams, label: string) => commit(p, label));
  // Shapes are drawn over the image, unless it shows something else (crop, before).
  const showShapes = shapeUi.editing && !framing && !comparing;

  // Keyboard shortcuts.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      // An open menu or dialog closes on Esc (in the capture phase): that's all this press does.
      if (e.key === 'Escape' && e.defaultPrevented) return;
      // The export dialog is modal: the shortcuts would act on the photo behind it.
      if (exportOpen) return;
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
      else if (!mod && key === '\\') setComparing(true);
      else if (!mod && key === 'c') startCrop();
      else if (mod && key === 'b') setAssessment((a) => !a);
      else if (!mod && key === 'o' && e.shiftKey) setClipping({ sensor: !clipping.sensor });
      else if (!mod && key === 'o') setClipping({ display: !clipping.display });
      else if (key === 'enter' && cropDraft) applyCrop();
      else if (key === 'escape' && cropDraft) setCropDraft(null);
      else if (key === 'enter' && guides) applyGuides();
      else if (key === 'escape' && guides) cancelGuides();
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

  const { entries, end } = history;
  const versionsNode = useMemo(() => versions?.(autosave.whenSaved), [versions, autosave.whenSaved]);
  const actionsNode = useMemo(() => actions?.({ entries, end }), [actions, entries, end]);
  const saveState = useMemo(
    () => save && { status: autosave.status, retry: autosave.flush },
    [!!save, autosave.status, autosave.flush],
  ); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Flex h="full" minH="0">
      <Flex
        ref={sidebar}
        as="aside"
        direction="column"
        w="56"
        flexShrink={0}
        borderRightWidth="1px"
        bg="bg.panel"
        minH="0"
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
            onSelect={onSelectEntry}
            onCompress={onCompress}
          />
        </Box>
      </Flex>
      <Flex direction="column" flex="1" minW="0">
        <Toolbar
          filename={filename}
          metadata={metadata}
          versions={versionsNode}
          styles={stylesNode}
          canUndo={canUndo}
          canRedo={canRedo}
          comparing={comparing}
          exporting={exporting}
          actions={actionsNode}
          onUndo={onUndo}
          onRedo={onRedo}
          onCompare={setComparing}
          onExport={openExport}
        />
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
              style={{ width: fitWidth, height: fitHeight }}
            >
              <canvas ref={canvas} style={{ width: '100%', height: '100%', display: 'block' }} />
              <canvas
                ref={regionCanvas}
                style={
                  region
                    ? {
                        position: 'absolute',
                        left: `${(100 * region.x) / region.frameWidth}%`,
                        top: `${(100 * region.y) / region.frameHeight}%`,
                        width: `${(100 * region.width) / region.frameWidth}%`,
                        height: `${(100 * region.height) / region.frameHeight}%`,
                        // Rendered at 100 %: larger zoom levels enlarge its pixels.
                        imageRendering: region.frameWidth >= regionFrame!.sourceWidth ? 'pixelated' : 'auto',
                      }
                    : { display: 'none' }
                }
              />
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
              {cropDraft && !comparing && (
                <CropOverlay
                  rect={cropDraft}
                  aspect={aspectRatio(aspect, frameAspect)}
                  frameAspect={frameAspect}
                  onChange={setCropDraft}
                />
              )}
            </Box>
          </Box>
          {!frame && <Spinner color="orange.solid" size="lg" position="absolute" />}
          {frame && <RenderSpinner busy={zoom ? regionPending : pending} frame={zoom ? regionFrame : frame} />}
          {error && (
            <Text position="absolute" bottom="3" color="fg.error" textStyle="sm">
              {error}
            </Text>
          )}
          {showShapes && shapeUi.tool !== 'select' && (
            <Text
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
            <HStack position="absolute" bottom="4" bg="bg.panel" p="2" borderRadius="md" boxShadow="lg">
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
            <HStack position="absolute" bottom="4" bg="bg.panel" p="2" borderRadius="md" boxShadow="lg">
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
          save={saveState}
          ms={(region ? regionFrame?.ms : frame?.ms) ?? null}
          zoom={zoom ? zoom.scale : null}
          fitScale={layout?.fitScale ?? 1}
          onZoom={cropDraft ? undefined : zoomTo}
          clipping={clipping}
          onClippingChange={setClipping}
          assessment={assessment}
          onAssessmentChange={setAssessment}
        />
      </Flex>

      <Box as="aside" w="80" flexShrink={0} borderLeftWidth="1px" bg="bg.panel" overflowY="auto">
        <ModulePanel
          params={params}
          lensCorrection={metadata.lensCorrection ?? null}
          asShotIlluminant={metadata.asShotIlluminant ?? null}
          onChange={onLiveChange}
          onCommit={onPanelCommit}
          presets={presets.modulePresets}
          onSavePreset={presets.save}
          onDeletePreset={presets.remove}
          luts={luts}
          missingLuts={missingLuts}
          onAddLut={onAddLut}
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
          shapeUi={shapeUi}
          onShapeUi={onShapeUi}
        />
      </Box>
      {creatingStyle && presets.save && (
        <CreateStyleDialog
          recipe={params}
          existing={presets.styles}
          onClose={() => setCreatingStyle(false)}
          onSave={presets.save}
        />
      )}
    </Flex>
  );
}
