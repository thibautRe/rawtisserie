import { Box, Button, Center, Flex, HStack, IconButton, Menu, Portal, Spinner, Stack, Text } from '@chakra-ui/react';
import { type CropRect, type EditParams, type PhotoMetadata, defaultEditParams } from '@rawtisserie/pipeline';
import { Check, Download, Redo2, SplitSquareHorizontal, Undo2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toaster } from '../components/toaster.tsx';
import { formatAperture, formatExposureTime, formatFocal, formatIso } from '../lib/format.ts';
import { CropOverlay, constrainAspect } from './CropOverlay.tsx';
import { ASPECTS, ModulePanel } from './ModulePanel.tsx';
import type { PipelineClient } from './pipelineClient.ts';
import { useParamsHistory } from './useParamsHistory.ts';
import { useRenderLoop } from './useRenderLoop.ts';

interface Props {
  client: PipelineClient;
  filename: string;
  metadata: PhotoMetadata;
  initialParams: EditParams;
  /** Persist the recipe (library mode). */
  onSave?: (params: EditParams) => Promise<unknown>;
  saving?: boolean;
  /** Extra toolbar actions, given the current parameters. */
  actions?: (params: EditParams) => React.ReactNode;
}

const MAX_PREVIEW = 3200;
const FULL_CROP: CropRect = { x: 0, y: 0, width: 1, height: 1 };

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

export function DeveloperView({ client, filename, metadata, initialParams, onSave, saving, actions }: Props) {
  const history = useParamsHistory(initialParams);
  const { params } = history;
  const [saved, setSaved] = useState(initialParams);
  const dirty = !!onSave && JSON.stringify(params) !== JSON.stringify(saved);

  const [comparing, setComparing] = useState(false);
  const [cropDraft, setCropDraft] = useState<CropRect | null>(null);
  const [aspect, setAspect] = useState('free');
  const [exporting, setExporting] = useState(false);

  // ── Rendering ──
  const [viewport, size] = useElementSize<HTMLDivElement>();
  const dpr = window.devicePixelRatio || 1;
  const effective = useMemo(() => {
    if (comparing) return defaultEditParams;
    if (cropDraft) return { ...params, geometry: { ...params.geometry, crop: FULL_CROP } };
    return params;
  }, [params, comparing, cropDraft !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  const job = useMemo(
    () => ({
      params: effective,
      width: Math.min(MAX_PREVIEW, Math.floor((size.width - 32) * dpr)),
      height: Math.min(MAX_PREVIEW, Math.floor((size.height - 32) * dpr)),
    }),
    [effective, size.width, size.height, dpr],
  );
  const { frame, error } = useRenderLoop(client, job);

  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvas.current;
    if (!c || !frame) return;
    c.width = frame.image.width;
    c.height = frame.image.height;
    c.getContext('2d')!.putImageData(frame.image, 0, 0);
  }, [frame]);

  // ── Crop ──
  const frameAspect = frame ? frame.image.width / frame.image.height : 1;
  const aspectRatio = (value: string) => {
    const a = ASPECTS.find((x) => x.value === value)?.ratio ?? null;
    return a === 'original' ? frameAspect : a;
  };
  const startCrop = () => {
    if (cropDraft) return applyCrop();
    setCropDraft(params.geometry.crop);
  };
  const applyCrop = () => {
    if (!cropDraft) return;
    history.commit({ ...params, geometry: { ...params.geometry, crop: cropDraft } });
    setCropDraft(null);
  };
  const changeAspect = (value: string) => {
    setAspect(value);
    const ratio = aspectRatio(value);
    if (cropDraft) setCropDraft(constrainAspect(cropDraft, ratio, frameAspect));
    else if (ratio) setCropDraft(constrainAspect(params.geometry.crop, ratio, frameAspect));
  };

  // ── Actions ──
  const save = async () => {
    if (!onSave) return;
    try {
      await onSave(params);
      setSaved(params);
      toaster.create({ type: 'success', title: 'Edit saved', description: 'Library previews are being re-rendered.' });
    } catch (err) {
      toaster.create({ type: 'error', title: 'Could not save', description: err instanceof Error ? err.message : undefined });
    }
  };

  const exportJpeg = async (maxSize: number) => {
    setExporting(true);
    try {
      const blob = await client.exportJpeg(params, maxSize);
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

  // Keyboard shortcuts.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && key === 'z' && !e.shiftKey) history.undo();
      else if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) history.redo();
      else if (mod && key === 's') void save();
      else if (!mod && key === '\\') setComparing(true);
      else if (!mod && key === 'c') startCrop();
      else if (key === 'enter' && cropDraft) applyCrop();
      else if (key === 'escape' && cropDraft) setCropDraft(null);
      else return;
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

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

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
      <Flex direction="column" flex="1" minW="0">
        <HStack px="3" py="2" borderBottomWidth="1px" gap="2">
          <Stack gap="0" minW="0" flex="1">
            <Text fontWeight="semibold" truncate>
              {filename}
              {dirty && (
                <Text as="span" color="orange.fg" title="Unsaved changes">
                  {' '}
                  •
                </Text>
              )}
            </Text>
            <Text textStyle="xs" color="fg.muted" truncate>
              {exif.join(' · ')}
            </Text>
          </Stack>
          <IconButton aria-label="Undo (Ctrl+Z)" size="sm" variant="ghost" disabled={!history.canUndo} onClick={history.undo}>
            <Undo2 />
          </IconButton>
          <IconButton aria-label="Redo (Ctrl+Shift+Z)" size="sm" variant="ghost" disabled={!history.canRedo} onClick={history.redo}>
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
          <Button size="sm" variant="ghost" onClick={() => history.commit(structuredClone(defaultEditParams))}>
            Reset all
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
          {actions?.(params)}
          {onSave && (
            <Button size="sm" colorPalette="orange" disabled={!dirty} loading={saving} onClick={() => void save()}>
              Save
            </Button>
          )}
        </HStack>

        <Center ref={viewport} flex="1" minH="0" bg="canvas" position="relative" overflow="hidden">
          {frame ? (
            <Box position="relative" lineHeight="0" boxShadow="2xl">
              <canvas
                ref={canvas}
                style={{ width: frame.image.width / dpr, height: frame.image.height / dpr, display: 'block' }}
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
          {frame && (
            <Text position="absolute" bottom="2" left="3" textStyle="2xs" color="fg.subtle" fontVariantNumeric="tabular-nums">
              {Math.round(frame.ms)} ms
            </Text>
          )}
        </Center>
      </Flex>

      <Box as="aside" w="80" flexShrink={0} borderLeftWidth="1px" bg="bg.panel" overflowY="auto">
        <ModulePanel
          params={params}
          onChange={history.setLive}
          onCommit={history.commit}
          cropping={!!cropDraft}
          aspect={aspect}
          onAspectChange={changeAspect}
          onStartCrop={startCrop}
        />
      </Box>
    </Flex>
  );
}
