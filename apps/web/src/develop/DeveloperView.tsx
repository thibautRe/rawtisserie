import { Box, Button, Center, Flex, HStack, IconButton, Menu, Portal, Spinner, Stack, Text } from '@chakra-ui/react';
import { type CropRect, type EditParams, type PhotoMetadata, defaultEditParams, findModule, updateModule } from '@rawtisserie/pipeline';
import { Check, Download, Redo2, SplitSquareHorizontal, Undo2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppMenu } from '../components/AppMenu.tsx';
import { toaster } from '../components/toaster.tsx';
import { formatAperture, formatExposureTime, formatFocal, formatIso } from '../lib/format.ts';
import { CropOverlay, constrainAspect } from './CropOverlay.tsx';
import { type HistorySnapshot, HistoryStore } from './history.ts';
import { HistoryPanel } from './HistoryPanel.tsx';
import { ASPECTS, ModulePanel } from './ModulePanel.tsx';
import type { RenderBackend } from './renderBackend.ts';
import { StatusBar, useClippingSettings } from './StatusBar.tsx';
import { type SaveFn, useAutosave } from './useAutosave.ts';
import { useRenderLoop } from './useRenderLoop.ts';

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
  /** Extra toolbar actions, given the current parameters and history. */
  actions?: (params: EditParams, history: HistorySnapshot) => React.ReactNode;
  /** Shown next to the file name (the version switcher), given a way to wait for pending saves. */
  versions?: (whenSaved: () => Promise<void>) => React.ReactNode;
  /** Go back to where the photo was opened from (Esc). */
  onBack?: () => void;
}

const MAX_PREVIEW = 3200;
const DRAFT_PIXELS = 1_000_000;
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

export function DeveloperView({ backend, filename, metadata, original, initialHistory, save, revision = 0, actions, versions, onBack }: Props) {
  const [store] = useState(() => new HistoryStore(original, initialHistory));
  const history = useSyncExternalStore(store.subscribe, store.getState);
  const params = history.live;
  /** A live change (e.g. a slider being dragged) has not been committed yet. */
  const live = params !== (history.entries[history.end - 1]?.recipe ?? original);
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

  // ── Rendering ──
  const [viewport, size] = useElementSize<HTMLDivElement>();
  const dpr = window.devicePixelRatio || 1;
  const effective = useMemo(() => {
    if (comparing) return defaultEditParams;
    if (cropDraft) return updateModule(params, 'geometry', { params: { crop: FULL_CROP } });
    return params;
  }, [params, comparing, cropDraft !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  // While a slider is being dragged, render a ~1 MP draft (the pipeline keeps its
  // caches for both sizes); the full-resolution render follows on release.
  const draft = live && !cropDraft;
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
    return { params: effective, width, height, scale, overlays };
  }, [effective, size.width, size.height, dpr, draft, margin, frameWidth, clipping]);
  const { frame, error } = useRenderLoop(backend, job);

  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvas.current;
    if (!c || !frame) return;
    c.width = frame.image.width;
    c.height = frame.image.height;
    c.getContext('2d')!.putImageData(frame.image, 0, 0);
  }, [frame]);

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
  const commit = (p?: EditParams) => {
    const snapshot = store.snapshot();
    const dropped = store.commit(p);
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
      const a = Object.assign(document.createElement('a'), { href: url, download: `${filename.replace(/\.[^.]+$/, '')}.jpg` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      toaster.create({ type: 'error', title: 'Export failed', description: err instanceof Error ? err.message : undefined });
    } finally {
      setExporting(false);
    }
  };

  // Filmic auto-tune, measured on the full-size preview (with the current crop).
  const autoTuneFilmic = async () => {
    setAutoTuning(true);
    try {
      const result = await backend.autoTuneFilmic(params, job.width, job.height);
      if (!result) throw new Error('Nothing to measure');
      const round = (v: number) => Math.round(v * 100) / 100;
      commit(updateModule(params, 'filmic', { params: { whiteExposure: round(result.white), blackExposure: round(result.black) } }));
    } catch (err) {
      toaster.create({ type: 'error', title: 'Auto-tune failed', description: err instanceof Error ? err.message : undefined });
    } finally {
      setAutoTuning(false);
    }
  };

  // Keyboard shortcuts.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      // An open menu or dialog closes on Esc (in the capture phase): that's all this press does.
      if (e.key === 'Escape' && e.defaultPrevented) return;
      const field = e.target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) ? e.target : null;
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

  const exif = [
    [metadata.make, metadata.model].filter(Boolean).join(' '),
    metadata.lensModel,
    formatFocal(metadata.focalLength),
    formatExposureTime(metadata.exposureTime),
    formatAperture(metadata.fNumber),
    formatIso(metadata.iso),
  ].filter(Boolean);

  return (
    <Flex h="full" minH="0">
      <Box as="aside" w="56" flexShrink={0} borderRightWidth="1px" bg="bg.panel" minH="0">
        <HistoryPanel original={original} entries={history.entries} end={history.end} onSelect={goto} onCompress={compress} />
      </Box>
      <Flex direction="column" flex="1" minW="0">
        <HStack px="3" py="2" borderBottomWidth="1px" gap="2">
          <AppMenu />
          <Stack gap="0" minW="0" flex="1">
            <HStack gap="1" minW="0">
              <Text fontWeight="semibold" truncate>
                {filename}
              </Text>
              {versions?.(autosave.whenSaved)}
            </HStack>
            <Text textStyle="xs" color="fg.muted" truncate>
              {exif.join(' · ')}
            </Text>
          </Stack>
          <IconButton aria-label="Undo (Ctrl+Z)" size="sm" variant="ghost" disabled={!canUndo} onClick={() => goto(history.end - 1)}>
            <Undo2 />
          </IconButton>
          <IconButton aria-label="Redo (Ctrl+Shift+Z)" size="sm" variant="ghost" disabled={!canRedo} onClick={() => goto(history.end + 1)}>
            <Redo2 />
          </IconButton>
          <Button
            size="sm"
            variant={comparing ? 'solid' : 'ghost'}
            title="Hold to see the unedited image (or hold \)"
            onPointerDown={() => setComparing(true)}
            onPointerUp={() => setComparing(false)}
            onPointerLeave={() => setComparing(false)}
          >
            <SplitSquareHorizontal /> Before
          </Button>
          <Menu.Root onSelect={(d) => void exportJpeg(Number(d.value))}>
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
          {actions?.(params, history)}
        </HStack>

        <Center ref={viewport} flex="1" minH="0" bg="canvas" position="relative" overflow="hidden">
          {frame ? (
            <Box
              position="relative"
              lineHeight="0"
              borderWidth={`${frameWidth}px`}
              borderStyle="solid"
              borderColor={frameWidth ? 'white' : 'transparent'}
            >
              <canvas
                ref={canvas}
                style={{ width: frame.fullWidth / dpr, height: frame.fullHeight / dpr, display: 'block' }}
              />
              {cropDraft && !comparing && (
                <CropOverlay rect={cropDraft} aspect={aspectRatio(aspect)} frameAspect={frameAspect} onChange={setCropDraft} />
              )}
            </Box>
          ) : (
            <Spinner color="orange.solid" size="lg" />
          )}
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
          save={save && { status: autosave.status, retry: autosave.flush }}
          ms={frame?.ms ?? null}
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
          onChange={(p) => store.setLive(p)}
          onCommit={commit}
          cropping={!!cropDraft}
          aspect={aspect}
          onAspectChange={changeAspect}
          onStartCrop={startCrop}
          onAutoTuneFilmic={() => void autoTuneFilmic()}
          autoTuning={autoTuning}
        />
      </Box>
    </Flex>
  );
}
