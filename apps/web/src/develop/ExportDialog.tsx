import { memo, useEffect, useRef, useState } from 'react';
import {
  Button,
  Center,
  CloseButton,
  Dialog,
  Field,
  HStack,
  Input,
  NativeSelect,
  Portal,
  Stack,
  Switch,
  Text,
  chakra,
} from '@chakra-ui/react';
import { DEFAULT_FRAME, type Frame, type FrameOrientation, frameLayout } from '@rawtisserie/pipeline';
import { ParamSlider } from './ParamSlider.tsx';
import { ASPECTS, aspectText, parseAspect } from './aspect.ts';

export interface ExportSettings {
  /** A value of `SIZES`, or `custom` for `customSize`. */
  size: string;
  /** Long edge in pixels, as typed. */
  customSize: string;
  /** JPEG quality, 1–100. */
  quality: number;
  framed: boolean;
  /** Its `aspect` follows `frameAspect`. */
  frame: Frame;
  /** The frame's aspect ratio: a value of `ASPECTS` (as the crop tool's) and the ratio typed for `custom`. */
  frameAspect: { preset: string; custom: string };
}

/** What to export, from the settings. */
export interface ExportRequest {
  /** Long edge in pixels, 0 for full resolution. Frames included. */
  maxSize: number;
  quality: number;
  frame: Frame | null;
}

const SIZES = [
  { value: '0', label: 'Full resolution' },
  { value: '3840', label: 'Long edge 3840 px' },
  { value: '2048', label: 'Long edge 2048 px' },
  { value: '1080', label: 'Long edge 1080 px' },
  { value: 'custom', label: 'Custom long edge…' },
];
const MIN_SIZE = 16;
/** JPEG's limit. */
const MAX_SIZE = 65_535;

/** The crop tool's ratios, except free-form; "original" is the photo's. */
const FRAME_ASPECTS = ASPECTS.filter((a) => a.value !== 'free').map((a) =>
  a.value === 'original' ? { ...a, label: 'Image' } : a,
);

const ORIENTATIONS: { value: FrameOrientation; label: string }[] = [
  { value: 'auto', label: 'Image' },
  { value: 'portrait', label: 'Portrait' },
  { value: 'landscape', label: 'Landscape' },
];

/** The frame's aspect for a preset: long side over short side, or 0 for the image's (and invalid ratios). */
function frameAspectRatio({ preset, custom }: ExportSettings['frameAspect']): number {
  const ratio = FRAME_ASPECTS.find((a) => a.value === preset)?.ratio ?? 'original';
  const r = ratio === 'original' ? null : ratio === 'custom' ? parseAspect(custom) : ratio;
  return r ? Math.max(r, 1 / r) : 0;
}

function customSize(text: string): number | null {
  const n = Number(text);
  return Number.isInteger(n) && n >= MIN_SIZE && n <= MAX_SIZE ? n : null;
}

/** The export these settings ask for, or null if the custom size is invalid. */
export function exportRequest(s: ExportSettings): ExportRequest | null {
  const maxSize = s.size === 'custom' ? customSize(s.customSize) : Number(s.size);
  if (maxSize === null) return null;
  return { maxSize, quality: s.quality, frame: s.framed ? s.frame : null };
}

const STORAGE_KEY = 'developer.export';
const DEFAULT_SETTINGS: ExportSettings = {
  size: '0',
  customSize: '1600',
  quality: 92,
  framed: false,
  frame: DEFAULT_FRAME,
  frameAspect: { preset: 'original', custom: '' },
};

/** The last export settings, so that a series of photos gets the same frame. */
export function loadExportSettings(): ExportSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<ExportSettings> | null;
    if (!saved || typeof saved !== 'object') return DEFAULT_SETTINGS;
    const s = { ...DEFAULT_SETTINGS, ...saved, frame: { ...DEFAULT_FRAME, ...saved.frame } };
    if (!SIZES.some((x) => x.value === s.size)) s.size = DEFAULT_SETTINGS.size;
    if (!FRAME_ASPECTS.some((a) => a.value === s.frameAspect?.preset)) s.frameAspect = DEFAULT_SETTINGS.frameAspect;
    s.quality = Math.round(Math.min(100, Math.max(1, Number(s.quality) || DEFAULT_SETTINGS.quality)));
    s.frame.aspect = frameAspectRatio(s.frameAspect);
    return s;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

const percent = (digits: number) => (v: number) => `${(v * 100).toFixed(digits)} %`;
/** A position from the centre: −50 % is against the left or top edge. */
const signedPercent = (v: number) => {
  const p = Math.round(v * 100);
  return `${p > 0 ? '+' : ''}${p} %`;
};

/**
 * Export options: size and an optional frame. The preview draws the frame around the
 * current render (`source`, the developer's canvas). Memoised: pass stable handlers.
 */
export const ExportDialog = memo(function ExportDialog({
  open,
  source,
  imageSize,
  onClose,
  onExport,
}: {
  open: boolean;
  source: React.RefObject<HTMLCanvasElement | null>;
  /** The (cropped) photo's size: a `bitmaprenderer` canvas doesn't tell its bitmap's. */
  imageSize: { width: number; height: number } | null;
  onClose: () => void;
  onExport: (request: ExportRequest) => void;
}) {
  const [settings, setSettings] = useState(loadExportSettings);
  useEffect(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)), [settings]);
  const { frame, framed } = settings;
  const setFrame = (patch: Partial<Frame>) => setSettings((s) => ({ ...s, frame: { ...s.frame, ...patch } }));
  // ParamSlider keeps its first handlers: read the current position, not this render's.
  const setPosition = (axis: 0 | 1, v: number) =>
    setSettings((s) => {
      const position: [number, number] = [...s.frame.position];
      position[axis] = v;
      return { ...s, frame: { ...s.frame, position } };
    });
  const setFrameAspect = (patch: Partial<ExportSettings['frameAspect']>) =>
    setSettings((s) => {
      const frameAspect = { ...s.frameAspect, ...patch };
      return { ...s, frameAspect, frame: { ...s.frame, aspect: frameAspectRatio(frameAspect) } };
    });
  const noAspect = frame.aspect < 1;
  const request = exportRequest(settings);
  const image = imageSize;
  const changeFrameAspect = (preset: string) => {
    // A custom ratio starts from the one shown: the preset's, or the photo's.
    let custom = settings.frameAspect.custom;
    if (preset === 'custom' && !custom.trim()) {
      const current = frame.aspect >= 1 ? frame.aspect : image && image.width / image.height;
      if (current) custom = aspectText(current);
    }
    setFrameAspect({ preset, custom });
  };
  // Only the axis with room to move the photo gets a position slider.
  const room = (axis: 'x' | 'y') => {
    if (noAspect) return false;
    if (!image) return true;
    const at = (p: number) => frameLayout({ ...frame, position: [p, p] }, image.width, image.height)[axis];
    return at(1) > at(0);
  };

  return (
    <Dialog.Root open={open} onOpenChange={(e) => !e.open && onClose()} size="lg">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content asChild>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!request) return;
                onClose();
                onExport(request);
              }}
            >
              <Dialog.Header>
                <Dialog.Title>Export JPEG</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <HStack align="start" gap="5">
                  <Stack gap="3" flex="1" minW="0">
                    <Field.Root>
                      <Field.Label textStyle="xs">Size</Field.Label>
                      <NativeSelect.Root size="sm">
                        <NativeSelect.Field
                          value={settings.size}
                          onChange={(e) => setSettings((s) => ({ ...s, size: e.target.value }))}
                        >
                          {SIZES.map((s) => (
                            <option key={s.value} value={s.value}>
                              {s.label}
                            </option>
                          ))}
                        </NativeSelect.Field>
                        <NativeSelect.Indicator />
                      </NativeSelect.Root>
                    </Field.Root>
                    {settings.size === 'custom' && (
                      <Field.Root invalid={!customSize(settings.customSize)}>
                        <HStack gap="2">
                          <Input
                            size="sm"
                            variant="subtle"
                            type="number"
                            min={MIN_SIZE}
                            max={MAX_SIZE}
                            step={1}
                            value={settings.customSize}
                            aria-label="Long edge in pixels"
                            onChange={(e) => setSettings((s) => ({ ...s, customSize: e.target.value }))}
                          />
                          <Text textStyle="sm" color="fg.muted">
                            px
                          </Text>
                        </HStack>
                        <Field.ErrorText>
                          From {MIN_SIZE} to {MAX_SIZE.toLocaleString('en')} px
                        </Field.ErrorText>
                      </Field.Root>
                    )}
                    <ParamSlider
                      label="Quality"
                      value={settings.quality}
                      min={50}
                      max={100}
                      hardMin={1}
                      step={1}
                      defaultValue={DEFAULT_SETTINGS.quality}
                      format={(v) => v.toFixed(0)}
                      onChange={(quality) => setSettings((s) => ({ ...s, quality }))}
                      onCommit={(quality) => setSettings((s) => ({ ...s, quality }))}
                    />
                    <Switch.Root
                      size="sm"
                      colorPalette="orange"
                      checked={framed}
                      onCheckedChange={(e) => setSettings((s) => ({ ...s, framed: e.checked }))}
                    >
                      <Switch.HiddenInput />
                      <Switch.Control />
                      <Switch.Label>Frame</Switch.Label>
                    </Switch.Root>
                    {framed && (
                      <Stack gap="2">
                        <ParamSlider
                          label="Border"
                          value={frame.size}
                          min={0}
                          max={0.25}
                          hardMax={1}
                          step={0.001}
                          scale={100}
                          defaultValue={DEFAULT_FRAME.size}
                          format={percent(1)}
                          onChange={(size) => setFrame({ size })}
                          onCommit={(size) => setFrame({ size })}
                        />
                        <HStack gap="2">
                          <Field.Root flex="1">
                            <Field.Label textStyle="xs">Aspect ratio</Field.Label>
                            <NativeSelect.Root size="xs">
                              <NativeSelect.Field
                                value={settings.frameAspect.preset}
                                onChange={(e) => changeFrameAspect(e.target.value)}
                              >
                                {FRAME_ASPECTS.map((a) => (
                                  <option key={a.value} value={a.value}>
                                    {a.label}
                                  </option>
                                ))}
                              </NativeSelect.Field>
                              <NativeSelect.Indicator />
                            </NativeSelect.Root>
                          </Field.Root>
                          <Field.Root flex="1" disabled={noAspect}>
                            <Field.Label textStyle="xs">Orientation</Field.Label>
                            <NativeSelect.Root size="xs" disabled={noAspect}>
                              <NativeSelect.Field
                                value={frame.orientation}
                                onChange={(e) => setFrame({ orientation: e.target.value as FrameOrientation })}
                              >
                                {ORIENTATIONS.map((o) => (
                                  <option key={o.value} value={o.value}>
                                    {o.label}
                                  </option>
                                ))}
                              </NativeSelect.Field>
                              <NativeSelect.Indicator />
                            </NativeSelect.Root>
                          </Field.Root>
                        </HStack>
                        {settings.frameAspect.preset === 'custom' && (
                          <Field.Root
                            invalid={
                              settings.frameAspect.custom.trim() !== '' && !parseAspect(settings.frameAspect.custom)
                            }
                          >
                            <Field.Label textStyle="xs">Custom ratio</Field.Label>
                            <Input
                              size="xs"
                              variant="subtle"
                              value={settings.frameAspect.custom}
                              placeholder="e.g. 65:24, 2.39 or A4"
                              onChange={(e) => setFrameAspect({ custom: e.target.value })}
                            />
                            <Field.ErrorText>A ratio such as 65:24, 2.39 or A4</Field.ErrorText>
                          </Field.Root>
                        )}
                        {room('x') && (
                          <ParamSlider
                            label="Horizontal position"
                            value={frame.position[0] - 0.5}
                            min={-0.5}
                            max={0.5}
                            step={0.01}
                            scale={100}
                            defaultValue={0}
                            format={signedPercent}
                            onChange={(x) => setPosition(0, x + 0.5)}
                            onCommit={(x) => setPosition(0, x + 0.5)}
                          />
                        )}
                        {room('y') && (
                          <ParamSlider
                            label="Vertical position"
                            value={frame.position[1] - 0.5}
                            min={-0.5}
                            max={0.5}
                            step={0.01}
                            scale={100}
                            defaultValue={0}
                            format={signedPercent}
                            onChange={(y) => setPosition(1, y + 0.5)}
                            onCommit={(y) => setPosition(1, y + 0.5)}
                          />
                        )}
                        <ColorField label="Colour" value={frame.color} onChange={(color) => setFrame({ color })} />
                        <ParamSlider
                          label="Line width"
                          value={frame.line}
                          min={0}
                          max={0.02}
                          hardMax={0.25}
                          step={0.0005}
                          scale={100}
                          defaultValue={0}
                          format={percent(2)}
                          onChange={(line) => setFrame({ line })}
                          onCommit={(line) => setFrame({ line })}
                        />
                        <ParamSlider
                          label="Line gap"
                          value={frame.lineOffset}
                          min={0}
                          max={0.05}
                          hardMax={1}
                          step={0.0005}
                          scale={100}
                          defaultValue={0}
                          format={percent(2)}
                          disabled={frame.line <= 0}
                          onChange={(lineOffset) => setFrame({ lineOffset })}
                          onCommit={(lineOffset) => setFrame({ lineOffset })}
                        />
                        <ColorField
                          label="Line colour"
                          value={frame.lineColor}
                          disabled={frame.line <= 0}
                          onChange={(lineColor) => setFrame({ lineColor })}
                        />
                        <Text textStyle="xs" color="fg.muted">
                          Sizes are relative to the photo's shorter side. The framed image fits the export size.
                        </Text>
                      </Stack>
                    )}
                  </Stack>
                  <Center w="280px" h="280px" flexShrink="0" bg="bg.muted" borderRadius="l2">
                    {open && image && <FramePreview source={source} image={image} frame={framed ? frame : null} />}
                  </Center>
                </HStack>
              </Dialog.Body>
              <Dialog.Footer>
                <Dialog.ActionTrigger asChild>
                  <Button variant="outline">Cancel</Button>
                </Dialog.ActionTrigger>
                <Button type="submit" colorPalette="orange" disabled={!request}>
                  Export
                </Button>
              </Dialog.Footer>
              <Dialog.CloseTrigger asChild>
                <CloseButton size="sm" />
              </Dialog.CloseTrigger>
            </form>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
});

const PREVIEW_SIZE = 260;

/** The current render in `frame`, as the export lays it out (`frameLayout`) at full size. */
function FramePreview({
  source,
  image,
  frame,
}: {
  source: React.RefObject<HTMLCanvasElement | null>;
  image: { width: number; height: number };
  frame: Frame | null;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const src = source.current;
    const c = canvas.current;
    const ctx = c?.getContext('2d');
    if (!src || !c || !ctx) return;
    const { width, height } = image;
    const l = frame ? frameLayout(frame, width, height) : { width, height, x: 0, y: 0, lineOffset: 0, lineWidth: 0 };
    const s = PREVIEW_SIZE / Math.max(l.width, l.height);
    c.width = Math.max(1, Math.round(l.width * s));
    c.height = Math.max(1, Math.round(l.height * s));
    ctx.setTransform(s, 0, 0, s, 0, 0);
    if (frame) {
      ctx.fillStyle = frame.color;
      ctx.fillRect(0, 0, l.width, l.height);
      if (l.lineWidth > 0) {
        // A stroke centred on the line's middle, at least a preview pixel wide.
        const w = Math.max(l.lineWidth, 1 / s);
        const d = l.lineOffset + w / 2;
        ctx.strokeStyle = frame.lineColor;
        ctx.lineWidth = w;
        ctx.strokeRect(l.x - d, l.y - d, width + 2 * d, height + 2 * d);
      }
    }
    // The canvas holds the fitted render (or a draft of it): stretched to the photo's place.
    ctx.drawImage(src, l.x, l.y, width, height);
  }, [source, image, frame]);
  return (
    <canvas ref={canvas} style={{ maxWidth: '100%', maxHeight: '100%', boxShadow: '0 1px 4px rgba(0,0,0,0.3)' }} />
  );
}

function ColorField({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  onChange: (color: string) => void;
}) {
  return (
    <HStack gap="2" opacity={disabled ? 0.5 : 1}>
      <Text textStyle="xs" flex="1">
        {label}
      </Text>
      {['#ffffff', '#808080', '#000000'].map((c) => (
        <chakra.button
          key={c}
          type="button"
          aria-label={c}
          title={c}
          w="5"
          h="5"
          borderRadius="full"
          borderWidth="1px"
          borderColor={value === c ? 'orange.solid' : 'border'}
          outline={value === c ? '2px solid' : undefined}
          outlineColor="orange.solid"
          style={{ background: c }}
          disabled={disabled}
          cursor={disabled ? 'default' : 'pointer'}
          onClick={() => onChange(c)}
        />
      ))}
      <input
        type="color"
        aria-label={`${label} (custom)`}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: 28, height: 22, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
      />
    </HStack>
  );
}
