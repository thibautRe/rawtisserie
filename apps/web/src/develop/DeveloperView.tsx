import { Box, Button, Center, Flex, HStack, IconButton, Menu, Portal, Spinner, Stack, Text } from '@chakra-ui/react';
import {
  type CropRect,
  type EditParams,
  type PhotoMetadata,
  type Style,
  type StyleMode,
  applyStyle,
  defaultEditParams,
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
import { CropOverlay, constrainAspect } from './CropOverlay.tsx';
import { type HistorySnapshot, HistoryStore } from './history.ts';
import { HistoryPanel } from './HistoryPanel.tsx';
import { ASPECTS, ModulePanel } from './ModulePanel.tsx';
import { CreateStyleDialog, StyleMenu, usePresetLibrary } from './presets.tsx';
import type { IlluminantDetection } from './protocol.ts';
import type { Frame, RenderBackend } from './renderBackend.ts';
import { StatusBar, useClippingSettings } from './StatusBar.tsx';
import { type SaveFn, useAutosave } from './useAutosave.ts';
import { useRenderLoop } from './useRenderLoop.ts';
import { useStableCallback } from './useStableCallback.ts';
import { type ZoomLayout, visibleRegion } from './zoom.ts';
import { useZoom } from './useZoom.ts';

interface Props {
  backend: RenderBackend;
  filename: string;
  metadata: PhotoMetadata;
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

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry!.contentRect;
      setSize({ width: Math.floor(r.width), height: Math.floor(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

/** Show the spinner once the image has waited this long for a new render. */
const SPINNER_DELAY_MS = 500;

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
  onExport: (maxSize: number) => void;
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
      <Menu.Root onSelect={(d) => onExport(Number(d.value))}>
        <Menu.Trigger asChild>
          <Button size="sm" variant="outline" loading={exporting} loadingText="Exporting…">
            <Download /> Export JPEG
          </Button>
        </Menu.Trigger>
        <Portal>
          <Menu.Positioner>
            <Menu.Content>
              <Menu.Item value="0">Full resolution</Menu.Item>
              <Menu.Item value="3840">Long edge 3840 px</Menu.Item>
              <Menu.Item value="2048">Long edge 2048 px</Menu.Item>
              <Menu.Item value="1080">Long edge 1080 px</Menu.Item>
            </Menu.Content>
          </Menu.Positioner>
        </Portal>
      </Menu.Root>
      {actions}
    </HStack>
  );
});

export function DeveloperView({
  backend,
  filename,
  metadata,
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
  const [cropDraft, setCropDraft] = useState<CropRect | null>(null);
  const [aspect, setAspect] = useState('free');
  const [exporting, setExporting] = useState(false);
  const [autoTuning, setAutoTuning] = useState(false);
  const [detecting, setDetecting] = useState<string | null>(null);

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
  // Zoomed in, the fitted render is mostly hidden: it stays at the committed recipe
  // while a slider is dragged, so that only the visible region is rendered.
  const fitParams = zoom && live ? committed : params;
  const withView = (p: EditParams) => {
    if (comparing) return defaultEditParams;
    if (cropDraft) return updateModule(p, 'geometry', { params: { crop: FULL_CROP } });
    return p;
  };
  const effective = useMemo(() => withView(params), [params, comparing, cropDraft !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  const fitEffective = useMemo(() => withView(fitParams), [fitParams, comparing, cropDraft !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  // While a slider is being dragged, render a ~0.5 MP draft (the pipeline keeps its
  // caches for both sizes); the full-resolution render follows on release.
  const draft = live && !cropDraft && !zoom;
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
    };
    return { params: fitEffective, width, height, scale, overlays };
  }, [fitEffective, size.width, size.height, dpr, draft, margin, frameWidth, clipping]);
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
    };
    return { params: effective, width, height, region, scale, overlays };
  }, [zoom, JSON.stringify(layout), effective, live, dpr, clipping]); // eslint-disable-line react-hooks/exhaustive-deps
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
    store.goto(seq);
  };
  const compress = () => {
    dismissUndo();
    setCropDraft(null);
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
  const aspectRatio = (value: string) => {
    const a = ASPECTS.find((x) => x.value === value)?.ratio ?? null;
    return a === 'original' ? frameAspect : a;
  };
  const crop = findModule(params, 'geometry')?.params.crop ?? FULL_CROP;
  const startCrop = () => {
    if (cropDraft) return applyCrop();
    setCropDraft(crop);
  };
  const applyCrop = () => {
    if (!cropDraft) return;
    commit(updateModule(params, 'geometry', { enabled: true, params: { crop: cropDraft } }));
    setCropDraft(null);
  };
  const changeAspect = (value: string) => {
    setAspect(value);
    const ratio = aspectRatio(value);
    if (cropDraft) setCropDraft(constrainAspect(cropDraft, ratio, frameAspect));
    else if (ratio) setCropDraft(constrainAspect(crop, ratio, frameAspect));
  };

  // ── Actions ──
  const exportJpeg = async (maxSize: number) => {
    setExporting(true);
    try {
      const blob = await backend.exportJpeg(params, maxSize);
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement('a'), {
        href: url,
        download: `${filename.replace(/\.[^.]+$/, '')}.jpg`,
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

  const onExport = useStableCallback((maxSize: number) => void exportJpeg(maxSize));

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

  // ── Presets and styles ──
  const presets = usePresetLibrary();
  const [creatingStyle, setCreatingStyle] = useState(false);
  const onApplyStyle = useStableCallback((style: Style, mode: StyleMode) => {
    setCropDraft(null);
    commit(applyStyle(params, style.payload, mode), `Style: ${style.name}${mode === 'append' ? ' (appended)' : ''}`);
  });
  const onCreateStyle = useStableCallback(() => setCreatingStyle(true));
  const stylesNode = useMemo(
    () =>
      presets.save && (
        <StyleMenu styles={presets.styles} onApply={onApplyStyle} onCreate={onCreateStyle} onDelete={presets.remove} />
      ),
    [presets.styles, !!presets.save], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // The module panel is memoised: its handlers must keep their identity.
  const onLiveChange = useStableCallback((p: EditParams) => store.setLive(p));
  const onPanelCommit = useStableCallback(commit);
  const onAspectChange = useStableCallback(changeAspect);
  const onStartCrop = useStableCallback(startCrop);
  const onAutoTuneFilmic = useStableCallback(() => void autoTuneFilmic());
  const onDetectIlluminant = useStableCallback(
    (id: string, method: IlluminantDetection) => void detectIlluminant(id, method),
  );

  // Keyboard shortcuts.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      // An open menu or dialog closes on Esc (in the capture phase): that's all this press does.
      if (e.key === 'Escape' && e.defaultPrevented) return;
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
      <Box as="aside" w="56" flexShrink={0} borderRightWidth="1px" bg="bg.panel" minH="0">
        <HistoryPanel
          original={original}
          entries={history.entries}
          end={history.end}
          onSelect={onSelectEntry}
          onCompress={onCompress}
        />
      </Box>
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
          onExport={onExport}
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
              {cropDraft && !comparing && (
                <CropOverlay
                  rect={cropDraft}
                  aspect={aspectRatio(aspect)}
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
          cropping={!!cropDraft}
          aspect={aspect}
          onAspectChange={onAspectChange}
          onStartCrop={onStartCrop}
          onAutoTuneFilmic={onAutoTuneFilmic}
          autoTuning={autoTuning}
          onDetectIlluminant={onDetectIlluminant}
          detecting={detecting}
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
