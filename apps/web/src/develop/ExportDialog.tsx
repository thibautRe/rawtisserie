import { memo, useEffect, useRef, useState } from 'react';
import {
  Button,
  Center,
  CloseButton,
  Dialog,
  Field,
  HStack,
  IconButton,
  Input,
  NativeSelect,
  Portal,
  Separator,
  Stack,
  Switch,
  Text,
  chakra,
} from '@chakra-ui/react';
import {
  COLOR_SPACES,
  DEFAULT_EXPORT_SETTINGS,
  DEFAULT_FRAME,
  EXPORT_FORMATS,
  type ExportPreset,
  type ExportSettings,
  FILENAME_TOKENS,
  type FilenameFields,
  type Frame,
  type FrameOrientation,
  MAX_EXPORT_SIZE,
  METADATA_MODES,
  SHARPENING,
  SIZE_MODES,
  exportFilename,
  frameLayout,
  normalizeExportSettings,
} from '@rawtisserie/pipeline';
import { BookmarkPlus, Trash2 } from 'lucide-react';
import { ParamSlider } from './ParamSlider.tsx';
import { ASPECTS, aspectText, parseAspect } from './aspect.ts';

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

/** Normalised settings, with a frame aspect preset the dialog knows and the frame's aspect from it. */
export function exportSettings(raw: unknown): ExportSettings {
  const s = normalizeExportSettings(raw);
  if (!FRAME_ASPECTS.some((a) => a.value === s.frameAspect.preset)) s.frameAspect = DEFAULT_EXPORT_SETTINGS.frameAspect;
  s.frame = { ...s.frame, aspect: frameAspectRatio(s.frameAspect) };
  return s;
}

const STORAGE_KEY = 'developer.export';

/** The settings of the last export on this device (without an account, the only ones kept). */
export function loadLocalExportSettings(): ExportSettings | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? exportSettings(JSON.parse(saved)) : null;
  } catch {
    return null;
  }
}

export function saveLocalExportSettings(settings: ExportSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

/**
 * The exported image's size, as the pipeline will fit it (`export::render_size`): the
 * widest photo whose framed image fits. Approximate by a pixel (the photo's height
 * rounds), so shown as such.
 */
export function estimateExportSize(
  s: ExportSettings,
  image: { width: number; height: number },
): { width: number; height: number } {
  const framed = (w: number) => {
    const h = Math.max(1, Math.round((w * image.height) / image.width));
    return s.framed ? frameLayout(s.frame, w, h) : { width: w, height: h };
  };
  const z = s.size;
  const fits = ({ width, height }: { width: number; height: number }) => {
    switch (z.mode) {
      case 'full':
        return true;
      case 'longEdge':
        return Math.max(width, height) <= z.longEdge;
      case 'shortEdge':
        return Math.min(width, height) <= z.shortEdge;
      case 'fit':
        return (!z.width || width <= z.width) && (!z.height || height <= z.height);
      case 'megapixels':
        return width * height <= Math.round(z.megapixels * 1e6);
    }
  };
  let lo = 1;
  let hi = image.width;
  if (fits(framed(hi))) return framed(hi);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(framed(mid))) lo = mid;
    else hi = mid;
  }
  return framed(lo);
}

const percent = (digits: number) => (v: number) => `${(v * 100).toFixed(digits)} %`;
/** A position from the centre: −50 % is against the left or top edge. */
const signedPercent = (v: number) => {
  const p = Math.round(v * 100);
  return `${p > 0 ? '+' : ''}${p} %`;
};

/** The settings (and presets) the dialog starts from, and what it can do with them. */
export interface ExportDialogProps {
  open: boolean;
  /** What the preview shows: the developer's canvas, or a photo's preview in the library. */
  source: React.RefObject<HTMLCanvasElement | HTMLImageElement | null>;
  /**
   * The (cropped) photo's size: a `bitmaprenderer` canvas doesn't tell its bitmap's.
   * Not `exact` (the library's preview's size): only its shape is used, no size is estimated.
   */
  imageSize: { width: number; height: number } | null;
  exact?: boolean;
  /** The settings to start from when the dialog opens (the last export's). */
  initial: ExportSettings;
  /** The user's export presets, or null without an account. */
  presets: ExportPreset[] | null;
  /** What file names can refer to: the photo's, or each photo's when exporting several. */
  filenameFields: FilenameFields | readonly FilenameFields[];
  onClose: () => void;
  onExport: (settings: ExportSettings) => void;
  onSavePreset: (name: string, settings: ExportSettings) => void;
  onDeletePreset: (preset: ExportPreset) => void;
}

/**
 * Export options (roadmap 8.5): format, colour space, size, output sharpening, an
 * optional frame, metadata and the file name, with export presets. The preview draws
 * the frame around the current render (`source`, the developer's canvas). Memoised:
 * pass stable handlers.
 */
export const ExportDialog = memo(function ExportDialog({
  open,
  source,
  imageSize,
  exact = true,
  initial,
  presets,
  filenameFields,
  onClose,
  onExport,
  onSavePreset,
  onDeletePreset,
}: ExportDialogProps) {
  const [settings, setSettings] = useState(initial);
  const [presetId, setPresetId] = useState('');
  const [naming, setNaming] = useState<string | null>(null);
  /** A preset being saved: selected once it's in the list. */
  const [saving, setSaving] = useState<string | null>(null);
  useEffect(() => {
    const saved = saving && presets?.find((p) => p.name === saving);
    if (!saved) return;
    setPresetId(saved.id);
    setSaving(null);
  }, [presets, saving]);
  const savePreset = (name: string) => {
    onSavePreset(name, settings);
    setSaving(name);
    setNaming(null);
  };
  /** Number fields holding text that isn't a valid number, by name. */
  const [invalid, setInvalid] = useState<Record<string, boolean>>({});
  // Each opening starts from the last export's settings.
  useEffect(() => {
    if (!open) return;
    setSettings(initial);
    setPresetId('');
    setNaming(null);
    setInvalid({});
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const { frame, framed } = settings;
  const set = (patch: Partial<ExportSettings>) => setSettings((s) => ({ ...s, ...patch }));
  const setSize = (patch: Partial<ExportSettings['size']>) =>
    setSettings((s) => ({ ...s, size: { ...s.size, ...patch } }));
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
  const validity = (name: string) => (valid: boolean) => setInvalid((v) => ({ ...v, [name]: !valid }));
  const noAspect = frame.aspect < 1;
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

  const format = EXPORT_FORMATS.find((f) => f.value === settings.format)!;
  const sizeMode = settings.size.mode;
  const visibleInvalid = Object.entries(invalid).some(
    ([name, bad]) => bad && (name.startsWith(`size.${sizeMode}`) || name === 'filename'),
  );
  const canExport = !visibleInvalid;
  const estimate = exact && image ? estimateExportSize(settings, image) : null;
  const preset = presets?.find((p) => p.id === presetId) ?? null;
  const modified = preset && JSON.stringify(exportSettings(preset.settings)) !== JSON.stringify(settings);
  const fields: readonly FilenameFields[] = 'filename' in filenameFields ? [filenameFields] : filenameFields;
  const count = fields.length;
  const names = fields.map((f) => exportFilename(settings.filename, f, format.extension));
  const name = names[0] ?? '';
  // Names that repeat get -2, -3… (`uniqueName`): say so, and how to tell them apart.
  const repeated = count - new Set(names).size;
  const wideJpeg =
    settings.format === 'jpeg' && estimate && Math.max(estimate.width, estimate.height) > MAX_EXPORT_SIZE;

  return (
    <Dialog.Root open={open} onOpenChange={(e) => !e.open && onClose()} size="xl" scrollBehavior="inside">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content asChild>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!canExport) return;
                onClose();
                onExport(settings);
              }}
            >
              <Dialog.Header>
                <Dialog.Title>{count > 1 ? `Export ${count.toLocaleString('en')} photos` : 'Export'}</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <HStack align="start" gap="5">
                  <Stack gap="3" flex="1" minW="0">
                    {presets && (
                      <Stack gap="1">
                        <HStack gap="2" align="end">
                          <Field.Root flex="1">
                            <Field.Label textStyle="xs">Preset{modified ? ' (modified)' : ''}</Field.Label>
                            <NativeSelect.Root size="sm">
                              <NativeSelect.Field
                                value={presetId}
                                onChange={(e) => {
                                  const p = presets.find((x) => x.id === e.target.value);
                                  setPresetId(e.target.value);
                                  if (p) setSettings(exportSettings(p.settings));
                                }}
                              >
                                <option value="">{presets.length ? 'Choose a preset…' : 'No presets yet'}</option>
                                {presets.map((p) => (
                                  <option key={p.id} value={p.id}>
                                    {p.name}
                                  </option>
                                ))}
                              </NativeSelect.Field>
                              <NativeSelect.Indicator />
                            </NativeSelect.Root>
                          </Field.Root>
                          <IconButton
                            aria-label="Save as preset"
                            title="Save as preset…"
                            size="sm"
                            variant="ghost"
                            onClick={() => setNaming(preset?.name ?? '')}
                          >
                            <BookmarkPlus />
                          </IconButton>
                          <IconButton
                            aria-label="Delete preset"
                            title="Delete preset"
                            size="sm"
                            variant="ghost"
                            disabled={!preset}
                            onClick={() => {
                              if (!preset) return;
                              onDeletePreset(preset);
                              setPresetId('');
                            }}
                          >
                            <Trash2 />
                          </IconButton>
                        </HStack>
                        {naming !== null && (
                          <HStack gap="2">
                            <Input
                              size="sm"
                              variant="subtle"
                              value={naming}
                              placeholder="Preset name"
                              maxLength={200}
                              autoFocus
                              aria-label="Preset name"
                              onChange={(e) => setNaming(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  if (naming.trim()) savePreset(naming.trim());
                                } else if (e.key === 'Escape') {
                                  e.stopPropagation();
                                  setNaming(null);
                                }
                              }}
                            />
                            <Button
                              size="sm"
                              colorPalette="orange"
                              disabled={!naming.trim()}
                              onClick={() => savePreset(naming.trim())}
                            >
                              Save
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setNaming(null)}>
                              Cancel
                            </Button>
                          </HStack>
                        )}
                        <Separator mt="2" />
                      </Stack>
                    )}
                    <HStack gap="2" align="start">
                      <Select
                        label="Format"
                        value={settings.format}
                        options={EXPORT_FORMATS}
                        onChange={(format) => set({ format })}
                      />
                      {settings.format !== 'jpeg' && (
                        <Select
                          label="Bit depth"
                          value={String(settings.depth)}
                          options={[
                            { value: '16', label: '16 bits' },
                            { value: '8', label: '8 bits' },
                          ]}
                          onChange={(depth) => set({ depth: depth === '8' ? 8 : 16 })}
                        />
                      )}
                      <Select
                        label="Colour space"
                        value={settings.colorSpace}
                        options={COLOR_SPACES}
                        onChange={(colorSpace) => set({ colorSpace })}
                      />
                    </HStack>
                    {settings.format === 'jpeg' && (
                      <ParamSlider
                        label="Quality"
                        value={settings.quality}
                        min={50}
                        max={100}
                        hardMin={1}
                        step={1}
                        defaultValue={DEFAULT_EXPORT_SETTINGS.quality}
                        format={(v) => v.toFixed(0)}
                        onChange={(quality) => setSettings((s) => ({ ...s, quality }))}
                        onCommit={(quality) => setSettings((s) => ({ ...s, quality }))}
                      />
                    )}
                    <HStack gap="2" align="start">
                      <Select
                        label="Size"
                        value={sizeMode}
                        options={SIZE_MODES}
                        onChange={(mode) => setSize({ mode })}
                      />
                      {sizeMode === 'longEdge' && (
                        <NumberField
                          label="Long edge"
                          unit="px"
                          value={settings.size.longEdge}
                          min={16}
                          max={MAX_EXPORT_SIZE}
                          onChange={(longEdge) => setSize({ longEdge })}
                          onValidity={validity('size.longEdge')}
                        />
                      )}
                      {sizeMode === 'shortEdge' && (
                        <NumberField
                          label="Short edge"
                          unit="px"
                          value={settings.size.shortEdge}
                          min={16}
                          max={MAX_EXPORT_SIZE}
                          onChange={(shortEdge) => setSize({ shortEdge })}
                          onValidity={validity('size.shortEdge')}
                        />
                      )}
                      {sizeMode === 'fit' && (
                        <>
                          <NumberField
                            label="Width"
                            unit="px"
                            value={settings.size.width}
                            min={0}
                            max={MAX_EXPORT_SIZE}
                            placeholder="Any"
                            onChange={(width) => setSize({ width })}
                            onValidity={validity('size.fit.width')}
                          />
                          <NumberField
                            label="Height"
                            unit="px"
                            value={settings.size.height}
                            min={0}
                            max={MAX_EXPORT_SIZE}
                            placeholder="Any"
                            onChange={(height) => setSize({ height })}
                            onValidity={validity('size.fit.height')}
                          />
                        </>
                      )}
                      {sizeMode === 'megapixels' && (
                        <NumberField
                          label="Megapixels"
                          unit="MP"
                          value={settings.size.megapixels}
                          min={0.01}
                          max={10_000}
                          integer={false}
                          onChange={(megapixels) => setSize({ megapixels })}
                          onValidity={validity('size.megapixels')}
                        />
                      )}
                    </HStack>
                    {estimate && (
                      <Text textStyle="xs" color={wideJpeg ? 'fg.error' : 'fg.muted'} mt="-1">
                        {estimate.width.toLocaleString('en')} × {estimate.height.toLocaleString('en')} px
                        {sizeMode === 'full' && !framed ? '' : ' (about)'}
                        {wideJpeg ? ': too large for JPEG (65,535 px at most)' : ''}
                      </Text>
                    )}
                    <Select
                      label="Output sharpening"
                      value={settings.sharpening}
                      options={SHARPENING}
                      onChange={(sharpening) => set({ sharpening })}
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
                    <Select
                      label="Metadata"
                      value={settings.metadata}
                      options={METADATA_MODES}
                      onChange={(metadata) => set({ metadata })}
                    />
                    <Field.Root invalid={invalid.filename}>
                      <Field.Label textStyle="xs">File name</Field.Label>
                      <Input
                        size="sm"
                        variant="subtle"
                        value={settings.filename}
                        maxLength={200}
                        onChange={(e) => {
                          set({ filename: e.target.value });
                          validity('filename')(e.target.value.trim() !== '');
                        }}
                      />
                      <HStack gap="1" wrap="wrap" mt="1">
                        {FILENAME_TOKENS.map((t) => (
                          <Button
                            key={t.token}
                            size="2xs"
                            variant="subtle"
                            title={t.description}
                            onClick={() => {
                              set({ filename: settings.filename + t.token });
                              validity('filename')(true);
                            }}
                          >
                            {t.token}
                          </Button>
                        ))}
                      </HStack>
                      <Field.HelperText textStyle="xs" truncate maxW="full">
                        {name}
                        {count > 1 ? `, ${names[1]}${count > 2 ? '…' : ''}` : ''}
                      </Field.HelperText>
                      {repeated > 0 && (
                        <Field.HelperText textStyle="xs" color="fg.warning">
                          {repeated === 1 ? 'One name repeats' : `${repeated} names repeat`}: they get -2, -3…
                          {settings.filename.includes('{version}') ? '' : ' Add {version} to tell versions apart.'}
                        </Field.HelperText>
                      )}
                      <Field.ErrorText>A file name pattern, e.g. {'{name}'}</Field.ErrorText>
                    </Field.Root>
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
                <Button type="submit" colorPalette="orange" disabled={!canExport}>
                  Export {format.label}
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

function Select<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <Field.Root flex="1">
      <Field.Label textStyle="xs">{label}</Field.Label>
      <NativeSelect.Root size="sm">
        <NativeSelect.Field value={value} onChange={(e) => onChange(e.target.value as T)}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </NativeSelect.Field>
        <NativeSelect.Indicator />
      </NativeSelect.Root>
    </Field.Root>
  );
}

/**
 * A number typed in a text field: `onChange` gets valid values only, and
 * `onValidity` tells whether the text is one.
 */
function NumberField({
  label,
  unit,
  value,
  min,
  max,
  integer = true,
  placeholder,
  onChange,
  onValidity,
}: {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  integer?: boolean;
  /** Shown for 0 (when `min` is 0, an unbounded side). */
  placeholder?: string;
  onChange: (value: number) => void;
  onValidity: (valid: boolean) => void;
}) {
  const shown = (v: number) => (placeholder && v === 0 ? '' : String(v));
  const [text, setText] = useState(() => shown(value));
  const parse = (t: string): number | null => {
    if (placeholder && !t.trim()) return 0;
    const n = Number(t);
    return t.trim() && Number.isFinite(n) && n >= min && n <= max && (!integer || Number.isInteger(n)) ? n : null;
  };
  // Follow outside changes (a preset applied).
  useEffect(() => {
    if (parse(text) !== value) {
      setText(shown(value));
      onValidity(true);
    }
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const valid = parse(text) !== null;
  return (
    <Field.Root flex="1" invalid={!valid}>
      <Field.Label textStyle="xs">{label}</Field.Label>
      <HStack gap="2" w="full">
        <Input
          size="sm"
          variant="subtle"
          inputMode={integer ? 'numeric' : 'decimal'}
          value={text}
          placeholder={placeholder}
          onChange={(e) => {
            setText(e.target.value);
            const n = parse(e.target.value);
            onValidity(n !== null);
            if (n !== null) onChange(n);
          }}
        />
        <Text textStyle="sm" color="fg.muted">
          {unit}
        </Text>
      </HStack>
      <Field.ErrorText>
        From {min.toLocaleString('en')} to {max.toLocaleString('en')}
        {placeholder ? ', or empty' : ''}
      </Field.ErrorText>
    </Field.Root>
  );
}

const PREVIEW_SIZE = 260;

/** The current render in `frame`, as the export lays it out (`frameLayout`) at full size. */
function FramePreview({
  source,
  image,
  frame,
}: {
  source: React.RefObject<HTMLCanvasElement | HTMLImageElement | null>;
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
