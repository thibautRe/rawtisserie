import {
  Box,
  Button,
  ButtonGroup,
  HStack,
  Heading,
  IconButton,
  Input,
  Menu,
  NativeSelect,
  Portal,
  Stack,
  Switch,
  Tabs,
  Text,
} from '@chakra-ui/react';
import {
  ADAPTATIONS,
  type Adaptation,
  type AutoCrop,
  BLEACH_LEVELS,
  type Bleach,
  FLUORESCENTS,
  type Fluorescent,
  IDENTITY_PRIMARIES,
  IDENTITY_WHITE_PRESERVING,
  ILLUMINANTS,
  type Illuminant,
  type MixerPrimaries,
  type MixerWhitePreserving,
  LEDS,
  type Led,
  TEMPERATURE_MAX,
  TEMPERATURE_MIN,
  type Xy,
  blackBodyXy,
  daylightXy,
  hueChromaToXy,
  asShotTemperature,
  illuminantXy,
  mixerMatrix,
  mixerRows,
  mixerWhite,
  primariesFromMatrix,
  primariesToMatrix,
  setTemperature,
  switchIlluminant,
  whitePreservingFromMatrix,
  whitePreservingToMatrix,
  withoutWhiteShift,
  xyToCss,
  xyToHueChroma,
  type EditParams,
  type MaskRange,
  EQUALIZER_CURVES,
  type EqualizerCurve,
  type ModuleInstance,
  type ModuleKind,
  type ModuleParams,
  PRIMARIES,
  type Primary,
  RGB_NORMS,
  type RgbNorm,
  TONE_CURVE_MAX_OFFSET,
  TONE_CURVE_NODES,
  TONE_HISTOGRAM_RANGE,
  toneCurveRange,
  type PrimaryName,
  PRESET_GROUPS,
  PRESET_KINDS,
  type ModulePreset,
  type ModulePresetPayload,
  SINGLE_INSTANCE_KINDS,
  MASKABLE_KINDS,
  addInstance,
  applyModulePreset,
  defaultModuleParams,
  instanceDefaults,
  isInstanceModified,
  moveInstance,
  removeInstance,
  resetInstance,
  updateInstance,
  LUT_INTERPOLATIONS,
  type LutInterpolation,
  SPOT_MODES,
  type ShapeType,
  type SpotMode,
  defaultSpot,
  removeSpot,
  updateShape,
  updateSpot,
  updateMask,
} from '@rawtisserie/pipeline';
import {
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Crop,
  EllipsisVertical,
  Ruler,
  FlipHorizontal2,
  Pencil,
  Pipette,
  Plus,
  RotateCcw,
  RotateCcwSquare,
  RotateCwSquare,
  Trash2,
  VenetianMask,
  WandSparkles,
  Eye,
} from 'lucide-react';
import { Fragment, memo, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { RenameDialog } from '../components/RenameDialog.tsx';
import { ASPECTS, type CropAspect, aspectLabel, parseAspect } from './aspect.ts';
import { MODULE_TITLES, instanceTitle } from './changes.ts';
import { CurveEditor } from './CurveEditor.tsx';
import type { PresetInput } from '../api/hooks.ts';
import { type FilmicRange, moveRange, pickRange } from './filmicRange.ts';
import { NO_PRESETS, type PresetLibrary, PresetMenu, SavePresetDialog } from './presets.tsx';
import { ParamSlider, fmt } from './ParamSlider.tsx';
import { type ShapeUi, hexToRec2020, isEditing, rec2020ToHex } from './retouch.ts';
import { MaskEditor } from './MaskEditor.tsx';
import { LutMenu } from './LutMenu.tsx';
import { useRecipePreview } from './preview.ts';
import type { LutChoice, LutLibrary } from './luts.ts';
import type { RangeKey } from './masks.ts';
import { BrushSettings, ShapeToolBar } from './ShapeTools.tsx';
import type { IlluminantDetection, PerspectiveFit, ToneCurveInput, ToneCurveView } from './protocol.ts';
import { useStableCallback } from './useStableCallback.ts';
import { sinhCurve, tracks } from './slider.ts';

interface Props {
  params: EditParams;
  /** Source of the file's embedded lens correction data (`PhotoMetadata.lensCorrection`). */
  lensCorrection: string | null;
  /** The file's as-shot light (`PhotoMetadata.asShotIlluminant`). */
  asShotIlluminant: Xy | null;
  onChange: (p: EditParams) => void;
  /** With a `label`, the change gets its own history entry under it. */
  onCommit: (p: EditParams, label?: string) => void;
  /** Module presets by kind (`PresetLibrary.modulePresets`). */
  presets: PresetLibrary['modulePresets'];
  /** Save a preset; null without an account. */
  onSavePreset: PresetLibrary['save'];
  onDeletePreset: (preset: ModulePreset) => void;
  cropping: boolean;
  aspect: CropAspect;
  /** Pick a value of `ASPECTS`. */
  onAspectChange: (preset: string) => void;
  /** Set the custom ratio's text. */
  onCustomAspectChange: (text: string) => void;
  /** Swap the crop's width and height. */
  onFlipAspect: () => void;
  onStartCrop: () => void;
  /** Perspective guides are being edited over the image. */
  guides: boolean;
  /** Edit the perspective guides (or apply them, when they are being edited). */
  onStartGuides: () => void;
  /** Fit the perspective to the guides (detected first, when they aren't being edited). */
  onFitPerspective: (mode: PerspectiveFit) => void;
  /** The perspective fit running, if any. */
  fittingPerspective: PerspectiveFit | null;
  /** Measure filmic's white/black relative exposures on the image. */
  onAutoTuneFilmic: () => void;
  autoTuning: boolean;
  /** Measure the scene's light for a colour calibration instance. */
  onDetectIlluminant: (id: string, method: IlluminantDetection) => void;
  /** The instance whose light is being measured. */
  detecting: string | null;
  /** What each tone curve instance reads on its input, by id, when measured. */
  toneInputs: Readonly<Record<string, ToneCurveInput>>;
  /** Fit a tone curve instance's nodes to its input. */
  onFitToneCurve: (id: string) => void;
  /** The tone curve instance being fitted. */
  fittingTone: string | null;
  /** What a tone curve instance reads, shown over the image (null: nothing shown). */
  toneView: ToneCurveView | null;
  onToneView: (view: ToneCurveView | null) => void;
  /** Retouch tools and selection, shared with the overlay on the image. */
  shapeUi: ShapeUi;
  onShapeUi: (patch: Partial<ShapeUi>) => void;
  /** Built-in and user LUTs (`useLutLibrary`), and those whose table couldn't be had. */
  luts: LutLibrary;
  missingLuts: ReadonlySet<string>;
  /** Decode and store a LUT file as the user's; null if it failed (and was reported). */
  onAddLut: (file: File) => Promise<LutChoice | null>;
  onRemoveLut: (lut: LutChoice) => void;
}

type InstanceAction = 'new' | 'rename' | 'up' | 'down' | 'delete';

/**
 * A module header's menu. Its handler goes through `latest`, so it's left out when
 * comparing props: this way dragging a slider doesn't restyle the menu.
 */
const InstanceMenu = memo(
  ({
    title,
    position,
    count,
    disabled,
    onAction,
  }: {
    title: string;
    position: number;
    count: number;
    disabled: boolean;
    onAction: (action: InstanceAction) => void;
  }) => (
    <Menu.Root lazyMount unmountOnExit onSelect={(d) => onAction(d.value as InstanceAction)}>
      <Menu.Trigger asChild>
        <IconButton
          aria-label={`${title} instances`}
          title="Module instances"
          size="2xs"
          variant="ghost"
          disabled={disabled}
        >
          <EllipsisVertical />
        </IconButton>
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content minW="40">
            <Menu.Item value="new">
              <Plus /> New instance
            </Menu.Item>
            <Menu.Item value="rename">
              <Pencil /> Rename…
            </Menu.Item>
            <Menu.Item value="up" disabled={position === 0}>
              <ArrowUp /> Move up
            </Menu.Item>
            <Menu.Item value="down" disabled={position >= count - 1}>
              <ArrowDown /> Move down
            </Menu.Item>
            <Menu.Separator />
            <Menu.Item
              value="delete"
              disabled={count <= 1}
              color="fg.error"
              _highlighted={{ bg: 'bg.error', color: 'fg.error' }}
            >
              <Trash2 /> Delete
            </Menu.Item>
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  ),
  (a, b) => a.title === b.title && a.position === b.position && a.count === b.count && a.disabled === b.disabled,
);

/**
 * A module header's mask button: adds a mask, then shows or hides its settings. Solid
 * while the mask is on, like an active shape tool. Memoised like `InstanceMenu`, without
 * its handler, so that dragging a slider doesn't restyle it.
 */
const MaskButton = memo(
  ({
    title,
    state,
    open,
    onClick,
  }: {
    title: string;
    state: 'none' | 'on' | 'off';
    open: boolean;
    onClick: () => void;
  }) => (
    <IconButton
      aria-label={state === 'none' ? `Add a mask to ${title}` : `${title} mask`}
      title={
        state === 'none'
          ? 'Add a mask: apply the module only to parts of the image, or blend it with its input (opacity, blend mode)'
          : open
            ? 'Hide the mask and blending settings'
            : 'Show the mask and blending settings'
      }
      size="2xs"
      variant={state === 'on' ? 'solid' : state === 'off' ? 'subtle' : 'ghost'}
      colorPalette={state === 'on' ? 'orange' : 'gray'}
      aria-pressed={state === 'on'}
      aria-expanded={state === 'none' ? undefined : open}
      onClick={onClick}
    >
      <VenetianMask />
    </IconButton>
  ),
  (a, b) => a.title === b.title && a.state === b.state && a.open === b.open,
);

/**
 * One module instance. A kind without an instance shows its default parameters,
 * switched off; editing it (or switching it on) adds an instance.
 */
function Module({
  title,
  enabled,
  modified,
  menu,
  actions,
  onToggle,
  onReset,
  children,
}: {
  title: string;
  enabled: boolean;
  modified: boolean;
  /** Absent for single-instance kinds. */
  menu?: React.ReactNode;
  /** Header buttons, shown left of the switch. */
  actions?: React.ReactNode;
  onToggle: (enabled: boolean) => void;
  onReset: () => void;
  children: React.ReactNode;
}) {
  return (
    <Stack gap="1.5" pt="1.5" pb="2.5" borderBottomWidth="1px">
      <HStack justify="space-between" h="6">
        <Heading
          size="xs"
          fontSize="2xs"
          textTransform="uppercase"
          letterSpacing="wider"
          color={modified ? 'orange.fg' : 'fg.muted'}
        >
          {title}
        </Heading>
        <HStack gap="1">
          {menu}
          {actions}
          <Switch.Root
            size="xs"
            colorPalette="orange"
            checked={enabled}
            onCheckedChange={(e) => onToggle(e.checked)}
            aria-label={`Enable ${title}`}
          >
            <Switch.HiddenInput />
            <Switch.Control />
          </Switch.Root>
          <IconButton aria-label={`Reset ${title}`} size="2xs" variant="ghost" disabled={!modified} onClick={onReset}>
            <RotateCcw />
          </IconButton>
        </HStack>
      </HStack>
      <Stack gap="1.5" opacity={enabled ? 1 : 0.5}>
        {children}
      </Stack>
    </Stack>
  );
}

/**
 * A part of the panel that only re-renders when `deps` change. Restyling every module
 * on every pointer move would take up the main thread during a drag, so `render` must
 * depend on nothing else (event handlers go through `latest` in `ModulePanel`).
 */
const Section = memo(
  ({ render }: { deps: readonly unknown[]; render: () => React.ReactNode }) => render(),
  (a, b) => a.deps.length === b.deps.length && a.deps.every((d, i) => d === b.deps[i]),
);

const EQUALIZER_LABELS: Record<EqualizerCurve, string> = {
  luma: 'Luminance contrast',
  chroma: 'Color contrast',
  edges: 'Edge awareness',
  lumaDenoise: 'Luminance denoise',
  chromaDenoise: 'Color denoise',
};

const PRIMARY_SWATCHES: Record<PrimaryName, string> = {
  red: 'red.solid',
  yellow: 'yellow.solid',
  green: 'green.solid',
  cyan: 'cyan.solid',
  blue: 'blue.solid',
  magenta: 'pink.solid',
};

/** CSS hue of each primary, for its gradient tracks. */
const PRIMARY_HUES: Record<PrimaryName, number> = {
  red: 0,
  yellow: 60,
  green: 120,
  cyan: 180,
  blue: 240,
  magenta: 300,
};

const ILLUMINANT_LABELS: Record<Illuminant, string> = {
  asShot: 'As shot',
  pipeline: 'Same as pipeline (D65)',
  daylight: 'Daylight',
  blackBody: 'Black body',
  a: 'A (incandescent)',
  e: 'E (equal energy)',
  fluorescent: 'Fluorescent',
  led: 'LED',
  custom: 'Custom',
};

const ADAPTATION_LABELS: Record<Adaptation, string> = {
  cat16: 'CAT16 (CIECAM16)',
  linearBradford: 'Linear Bradford (ICC v4)',
  xyz: 'XYZ',
  none: 'None (bypass)',
};

const FLUORESCENT_LABELS: Record<Fluorescent, string> = {
  f1: 'F1 (daylight 6430 K), medium CRI',
  f2: 'F2 (cool white 4230 K), medium CRI',
  f3: 'F3 (white 3450 K), medium CRI',
  f4: 'F4 (warm white 2940 K), medium CRI',
  f5: 'F5 (daylight 6350 K), medium CRI',
  f6: 'F6 (lite white 4150 K), medium CRI',
  f7: 'F7 (D65 simulator 6500 K), high CRI',
  f8: 'F8 (D50 simulator 5000 K), high CRI',
  f9: 'F9 (cool white deluxe 4150 K), high CRI',
  f10: 'F10 (tuned RGB 5000 K), low CRI',
  f11: 'F11 (tuned RGB 4000 K), low CRI',
  f12: 'F12 (tuned RGB 3000 K), low CRI',
};

const LED_LABELS: Record<Led, string> = {
  b1: 'B1 (blue 2733 K)',
  b2: 'B2 (blue 2998 K)',
  b3: 'B3 (blue 4103 K)',
  b4: 'B4 (blue 5109 K)',
  b5: 'B5 (blue 6598 K)',
  bh1: 'BH1 (blue-red hybrid 2851 K)',
  rgb1: 'RGB1 (RGB 2840 K)',
  v1: 'V1 (violet 2724 K)',
  v2: 'V2 (violet 4070 K)',
};

type Calibration = ModuleParams['colorCalibration'];

/** Colour calibration's tabs, as Ansel's: the light, the mix, and what is done with it. */
/**
 * A select with its label on the left. The label isn't part of the options, so typing
 * on the focused select jumps to the option starting with the typed letters.
 */
/**
 * Geometry's perspective header (the guides button) and fit buttons. Memoised, like
 * `InstanceMenu`: handlers go through `latest` and are left out when comparing, so that
 * dragging the geometry sliders doesn't restyle these.
 */
const PerspectiveTools = memo(
  ({
    guides,
    fitting,
    onGuides,
    onFit,
  }: {
    guides: boolean;
    fitting: PerspectiveFit | null;
    onGuides: () => void;
    onFit: (mode: PerspectiveFit) => void;
  }) => (
    <>
      <HStack justify="space-between" pt="1">
        <Text textStyle="2xs" fontWeight="medium" color="fg.muted">
          Perspective
        </Text>
        <Button
          size="xs"
          variant={guides ? 'solid' : 'outline'}
          colorPalette={guides ? 'orange' : 'gray'}
          title="Show the lines found in the image: pick those that should be straight, or draw your own"
          onClick={onGuides}
        >
          <Ruler /> {guides ? 'Editing guides…' : 'Guides'}
        </Button>
      </HStack>
      <HStack gap="2">
        <Text textStyle="xs" color="fg.muted" w="16" flexShrink={0}>
          Fit
        </Text>
        <ButtonGroup size="xs" variant="outline" attached flex="1">
          {PERSPECTIVE_FITS.map((f) => (
            <Button
              key={f.mode}
              flex="1"
              title={f.hint}
              loading={fitting === f.mode}
              disabled={fitting !== null}
              onClick={() => onFit(f.mode)}
            >
              {f.label}
            </Button>
          ))}
        </ButtonGroup>
      </HStack>
    </>
  ),
  (a, b) => a.guides === b.guides && a.fitting === b.fitting,
);

/** Geometry's auto-crop mode ('off' is offered only when set). Memoised like `PerspectiveTools`. */
const AutoCropSelect = memo(
  ({ value, onChange }: { value: AutoCrop; onChange: (v: AutoCrop) => void }) => (
    <SelectRow label="Auto-crop">
      {(id) => (
        <NativeSelect.Root size="xs" flex="1">
          <NativeSelect.Field id={id} value={value} onChange={(ev) => onChange(ev.target.value as AutoCrop)}>
            <option value="aspect">Keep the aspect ratio</option>
            <option value="area">Largest area</option>
            {value === 'off' && <option value="off">None (empty borders)</option>}
          </NativeSelect.Field>
          <NativeSelect.Indicator />
        </NativeSelect.Root>
      )}
    </SelectRow>
  ),
  (a, b) => a.value === b.value,
);

const PERSPECTIVE_FITS: readonly { mode: PerspectiveFit; label: string; hint: string }[] = [
  { mode: 'vertical', label: 'Vertical', hint: 'Make the vertical guides vertical (and parallel)' },
  { mode: 'horizontal', label: 'Horizontal', hint: 'Make the horizontal guides horizontal (and parallel)' },
  { mode: 'both', label: 'Both', hint: 'Make the vertical guides vertical and the horizontal ones horizontal' },
];

function SelectRow({ label, children }: { label: string; children: (id: string) => React.ReactNode }) {
  const id = useId();
  return (
    <HStack gap="2" flex="1" minW="0">
      <Text asChild textStyle="xs" color="fg.muted" w="16" flexShrink={0}>
        <label htmlFor={id}>{label}</label>
      </Text>
      {children(id)}
    </HStack>
  );
}

const CALIBRATION_PAGES = ['illuminant', 'mixer', 'output'] as const;
type CalibrationPage = (typeof CALIBRATION_PAGES)[number];
const CALIBRATION_PAGE_LABELS = Object.fromEntries(
  CALIBRATION_PAGES.map((page) => [page, PRESET_GROUPS.colorCalibration![page]!.label]),
) as Record<CalibrationPage, string>;
const CALIBRATION_PAGE_TITLES: Record<CalibrationPage, string> = {
  illuminant: 'White balance: chromatic adaptation from the scene’s light',
  mixer: 'Channel mixer',
  output: 'Colorfulness, brightness and gray (monochrome), after the mix',
};
/** The parameters each tab edits, to mark the tabs that differ from the defaults. */
const CALIBRATION_PAGE_KEYS = Object.fromEntries(
  CALIBRATION_PAGES.map((page) => [page, PRESET_GROUPS.colorCalibration![page]!.keys]),
) as Record<CalibrationPage, readonly (keyof Calibration)[]>;

/** The groups of the output tab, in the order they apply. */
const OUTPUT_GROUPS = [
  {
    key: 'colorfulness',
    title: 'Colorfulness',
    min: -1,
    max: 1,
    hardMin: -1,
    hardMax: 1,
    hint: 'Offset the coefficients so that they add up to 0',
  },
  {
    key: 'brightness',
    title: 'Brightness',
    min: -1,
    max: 1,
    hardMin: -1,
    hardMax: 1,
    hint: 'Offset the coefficients so that they add up to 0',
  },
  {
    key: 'grey',
    title: 'Gray (monochrome when not 0)',
    min: 0,
    max: 1,
    hardMin: -2,
    hardMax: 2,
    hint: 'Scale the coefficients so that they add up to 1 (keeps the brightness)',
  },
] as const;

/** Ways to see and edit the mixer's matrix (Ansel's mixer modes). */
const MIXER_VIEWS = ['primaries', 'whitePreserving', 'channels'] as const;
type MixerView = (typeof MIXER_VIEWS)[number];
const MIXER_VIEW_LABELS: Record<MixerView, string> = {
  primaries: 'Primaries',
  whitePreserving: 'White-preserving',
  channels: 'Channels',
};
const MIXER_VIEW_TITLES: Record<MixerView, string> = {
  primaries: 'Each input channel’s hue and purity, and where the white goes',
  whitePreserving: 'Each input channel’s rotation and saturation; whites stay white',
  channels: 'Each output channel as a mix of the input channels',
};
const CHANNELS = ['Red', 'Green', 'Blue'] as const;
const CHANNEL_TRACKS = [tracks.channel('#d04a3a'), tracks.channel('#3aa04a'), tracks.channel('#3a6ad0')];
const NORMALIZE_KEYS = {
  red: 'normalizeRed',
  green: 'normalizeGreen',
  blue: 'normalizeBlue',
  colorfulness: 'normalizeColorfulness',
  brightness: 'normalizeBrightness',
  grey: 'normalizeGrey',
} as const;

/** The mixer's primaries modes: the matrix seen as primaries, and back. */
/** The mixer's primary hue sliders: finer around 0°, over the same ±90° track. */
const HUE_CURVE = sinhCurve(90);
/** Glow radius: fine at the small radii of halation, coarse up to large blooms. */
const GLOW_RADIUS_CURVE = sinhCurve(500, 3);

const MIXER_MODES = {
  primaries: { read: primariesFromMatrix, write: primariesToMatrix, identity: IDENTITY_PRIMARIES },
  whitePreserving: {
    read: whitePreservingFromMatrix,
    write: whitePreservingToMatrix,
    identity: IDENTITY_WHITE_PRESERVING,
  },
} as const;
type MixerMode = keyof typeof MIXER_MODES;
type MixerKey = keyof MixerPrimaries | keyof MixerWhitePreserving;

/**
 * Angles that mean nothing when their magnitude is zero (a primary on the white): the
 * matrix then doesn't hold them, so the panel remembers the last one set.
 */
const MIXER_ANGLES: Record<MixerMode, [angle: MixerKey, magnitude: MixerKey, zero: number][]> = {
  primaries: [
    ['whiteHue', 'whitePurity', 0],
    ['redHue', 'redPurity', 0],
    ['greenHue', 'greenPurity', 0],
    ['blueHue', 'bluePurity', 0],
  ],
  whitePreserving: [
    ['redRotation', 'redSaturation', -1],
    ['greenRotation', 'greenSaturation', -1],
    ['blueRotation', 'blueSaturation', -1],
  ],
};
/** Below this distance from zero, a magnitude counts as zero (the matrix is rounded). */
const ZERO_MAGNITUDE = 1e-4;

/** The CSS hue of each primary, for slider tracks. */
const PRIMARY_CSS_HUES = [0, 120, 240];
/** Signed degrees, without "-0.0°" for tiny negative angles read back from the matrix. */
const degrees = (v: number) => {
  const r = Number(v.toFixed(1)) + 0;
  return `${r > 0 ? '+' : ''}${r.toFixed(1)}°`;
};

/** Soft range of the temperature slider, and its track: the light's colour. */
const TEMPERATURE_SOFT = [2000, 12000] as const;
const TEMPERATURE_TRACK = `linear-gradient(to right, ${Array.from({ length: 11 }, (_, i) => {
  const t = TEMPERATURE_SOFT[0] + (i / 10) * (TEMPERATURE_SOFT[1] - TEMPERATURE_SOFT[0]);
  return xyToCss((t >= 4000 ? daylightXy(t) : blackBodyXy(t))!);
}).join(', ')})`;

/** What an instance's section shows, which isn't part of the recipe. */
type ToneChannel = 'red' | 'green' | 'blue';
const TONE_CHANNELS: readonly ToneChannel[] = ['red', 'green', 'blue'];
const TONE_CHANNEL_COLORS: Record<ToneChannel, string> = { red: '#e5484d', green: '#30a46c', blue: '#3e63dd' };

const RGB_NORM_LABELS: Record<RgbNorm, string> = {
  none: 'None (each channel)',
  luminance: 'Luminance',
  max: 'Max RGB',
  average: 'Average RGB',
  norm: 'Norm RGB',
  power: 'Power',
};

/** A tone curve node's offset (EV) as the curve editor's 0 … 1, and back. */
const toneToUnit = (offsets: readonly number[]) =>
  offsets.map(
    (v) => 0.5 + Math.min(TONE_CURVE_MAX_OFFSET, Math.max(-TONE_CURVE_MAX_OFFSET, v)) / (2 * TONE_CURVE_MAX_OFFSET),
  );
const toneFromUnit = (values: readonly number[]) =>
  values.map((v) => Math.round((v - 0.5) * 2 * TONE_CURVE_MAX_OFFSET * 1000) / 1000);
/** Input exposure of tone curve node `i` with the nodes over `[lo, hi]`, EV relative to middle grey. */
const toneNodeEv = (i: number, [lo, hi]: readonly [number, number]) => lo + ((hi - lo) * i) / (TONE_CURVE_NODES - 1);
/**
 * A tone curve's input histogram over `[lo, hi]`, for `CurveEditor`: the fullest bin
 * under each sample, square-rooted so that small counts show.
 */
function toneHistogram(bins: readonly number[], [lo, hi]: readonly [number, number]): number[] {
  const [a, b] = TONE_HISTOGRAM_RANGE;
  const n = bins.length;
  const bin = (ev: number) => Math.floor(((ev - a) / (b - a)) * n);
  const samples = 96;
  const step = (hi - lo) / samples;
  return Array.from({ length: samples + 1 }, (_, k) => {
    const ev = lo + step * k;
    let top = 0;
    for (let i = Math.max(0, bin(ev - step / 2)); i <= Math.min(n - 1, bin(ev + step / 2)); i++) {
      top = Math.max(top, bins[i]!);
    }
    return Math.sqrt(top) * 0.9;
  });
}
const signedEv = (v: number) =>
  `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v)
    .toFixed(2)
    .replace(/\.?0+$/, '')} EV`;
const TONE_FLAT = toneToUnit(Array<number>(TONE_CURVE_NODES).fill(0));

interface InstanceView {
  primary: PrimaryName;
  primariesAdvanced: boolean;
  calibrationAdvanced: boolean;
  curve: EqualizerCurve;
  /** The tone curve channel shown, with independent channels. */
  toneChannel: ToneChannel;
  calibration: CalibrationPage;
  mixer: MixerView;
  /** Angles remembered while their magnitude is zero (see `MIXER_ANGLES`). */
  angles: Record<string, number>;
  /** The mask editor is open (when the instance has a mask). */
  maskOpen: boolean;
  /** Mask ranges as they were when switched off, to bring back when switched on. */
  maskRanges: Partial<Record<RangeKey, MaskRange>>;
}

const DEFAULT_VIEW: InstanceView = {
  primary: 'red',
  primariesAdvanced: false,
  calibrationAdvanced: false,
  curve: 'luma',
  toneChannel: 'red',
  calibration: 'illuminant',
  mixer: 'primaries',
  angles: {},
  maskOpen: true,
  maskRanges: {},
};

/** A typed ratio the other way round (`51:48` → `48:51`), as shown once swapped. */
function flipRatioText(text: string): string {
  const m = /^\s*([^:/x×*]+?)\s*([:/x×*])\s*(.+?)\s*$/i.exec(text);
  if (m) return `${m[3]}${m[2]}${m[1]}`;
  const r = parseAspect(text);
  return r ? `1:${text.trim()}` : text;
}

const isCropped = (c: ModuleParams['geometry']['crop']) => c.x !== 0 || c.y !== 0 || c.width !== 1 || c.height !== 1;

/** Scroll a spot's row into view within its list (but not the panel). */
const scrollIntoList = (row: HTMLDivElement | null) => {
  const list = row?.parentElement;
  if (!row || !list) return;
  if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
  else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight)
    list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
};

const SPOT_MODE_LABELS: Record<SpotMode, string> = { heal: 'Heal', clone: 'Clone', fill: 'Fill', blur: 'Blur' };
const SHAPE_LABELS: Record<ShapeType, string> = {
  ellipse: 'ellipse',
  gradient: 'gradient',
  path: 'path',
  brush: 'brush',
};

const INTERPOLATION_LABELS: Record<LutInterpolation, string> = {
  tetrahedral: 'Tetrahedral',
  trilinear: 'Trilinear',
  pyramid: 'Pyramid',
};

const BLEACH_LABELS: Record<Bleach, string> = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  extra: 'Extra',
};

/**
 * Memoised: a new frame re-renders the developer, not this. Handlers must be stable
 * (`useStableCallback`); they are read through `latest` anyway.
 */
export const ModulePanel = memo(function ModulePanel(props: Props) {
  const { params, lensCorrection, asShotIlluminant, cropping, aspect, autoTuning, detecting, shapeUi } = props;
  const { guides, fittingPerspective } = props;
  const { toneInputs, fittingTone, toneView } = props;
  const { luts, missingLuts } = props;
  // Handlers of a section that didn't re-render must still see the latest recipe and callbacks.
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  // What each instance shows, by id.
  const [views, setViews] = useState<Record<string, InstanceView>>({});

  // The same angles, for handlers: updated as soon as they are set.
  const angles = useRef<Record<string, Record<string, number>>>({});
  const setAngle = (id: string, key: string, value: number) => {
    if (angles.current[id]?.[key] === value) return;
    const next = { ...angles.current[id], [key]: value };
    angles.current[id] = next;
    setViews((v) => ({ ...v, [id]: { ...DEFAULT_VIEW, ...v[id], angles: next } }));
  };

  const [renaming, setRenaming] = useState<string | null>(null);
  const renamed = params.modules.find((m) => m.id === renaming);
  // Stable, so that the (memoised) dialog stays out of slider drags.
  const onRenameClose = useStableCallback(() => setRenaming(null));
  const onRename = useStableCallback(
    (label: string | null) => renamed && commit((p) => updateInstance(p, renamed.kind, renamed.id, { label })),
  );

  const commit = (change: (p: EditParams) => EditParams, label?: string) =>
    latest.current.onCommit(change(latest.current.params), label);

  // The instance (or the empty kind's future one) being saved as a preset.
  const [savingPreset, setSavingPreset] = useState<{ kind: ModuleKind; id: string; title: string } | null>(null);
  const onSavePresetClose = useStableCallback(() => setSavingPreset(null));
  const onSavePreset = useStableCallback((input: PresetInput) => latest.current.onSavePreset?.(input));

  // While a preset or LUT menu item is highlighted, it's shown on the image.
  const { preview, end: endPreview } = useRecipePreview(
    () => latest.current.params,
    (p) => latest.current.onChange(p),
  );

  /** Lets the content of one instance read and edit it. Without an instance, this is its future one. */
  function editor<K extends ModuleKind>(kind: K, m: ModuleInstance<K> | undefined, position: number) {
    const defaults = instanceDefaults(kind, position);
    const id = m?.id ?? kind;
    const values = m?.params ?? defaultModuleParams[kind];
    // Editing a module switches it on, as in Ansel.
    const edit = (patch: Partial<ModuleParams[K]>) =>
      updateInstance(latest.current.params, kind, id, { enabled: true, params: patch });
    /** Props for a slider bound to a numeric parameter. */
    const bind = (key: keyof ModuleParams[K] & string) => {
      const with_ = (v: number) => edit({ [key]: v } as Partial<ModuleParams[K]>);
      return {
        value: values[key] as number,
        defaultValue: defaults[key] as number,
        onChange: (v: number) => latest.current.onChange(with_(v)),
        onCommit: (v: number) => latest.current.onCommit(with_(v)),
      };
    };
    /** The parameters now, for handlers (sliders keep their first ones). */
    const current = () =>
      (latest.current.params.modules.find((x) => x.id === id) as ModuleInstance<K> | undefined)?.params ??
      defaultModuleParams[kind];
    const setView = (patch: Partial<InstanceView>) =>
      setViews((v) => ({ ...v, [id]: { ...DEFAULT_VIEW, ...v[id], ...patch } }));
    return {
      id,
      view: views[id] ?? DEFAULT_VIEW,
      setView,
      values,
      defaults,
      current,
      enabled: m?.enabled ?? false,
      edit,
      set: (patch: Partial<ModuleParams[K]>) => latest.current.onCommit(edit(patch)),
      bind,
    };
  }

  /**
   * A section per instance of a kind (or one for the kind, without any). Sections are
   * keyed by instance id and an empty kind's first instance takes the kind as its id,
   * so a slider dragged there stays mounted, bound to that id.
   */
  function sections<K extends ModuleKind>(
    kind: K,
    deps: readonly unknown[],
    content: (e: ReturnType<typeof editor<K>>) => React.ReactNode,
    actions?: (e: ReturnType<typeof editor<K>>) => React.ReactNode,
  ) {
    const list = params.modules.filter((m) => m.kind === kind) as ModuleInstance<K>[];
    const count = list.length;
    const presets = props.presets[kind] ?? NO_PRESETS;
    const canSave = !!props.onSavePreset;
    const maskable = MASKABLE_KINDS.includes(kind);
    return (count ? list : [undefined]).map((m, position) => {
      const id = m?.id ?? kind;
      const title = m ? instanceTitle(params, m) : MODULE_TITLES[kind];
      // What the mask editor shows besides the instance: its shapes' types (not the
      // shapes, which change on every move of a drag), and the shape tools' state while
      // they edit this mask.
      const maskTypes = m?.mask?.drawn.map((d) => params.shapes?.[d.shape]?.type);
      const maskDeps = maskable
        ? [
            maskTypes?.join(),
            isEditing(shapeUi, 'mask', id) ? shapeUi : null,
            shapeUi.maskOverlay?.id === id ? shapeUi.maskOverlay : null,
          ]
        : [];
      return (
        <Section
          key={id}
          deps={[m, position, count, title, views[id], presets, canSave, ...maskDeps, ...deps]}
          render={() => {
            const e = editor(kind, m, position);
            const mask = m?.mask;
            const maskButton = maskable && (
              <MaskButton
                title={title}
                state={mask ? (mask.enabled ? 'on' : 'off') : 'none'}
                open={e.view.maskOpen}
                onClick={() => {
                  // Read when clicked: the button keeps its first handler.
                  const now = latest.current.params.modules.find((x) => x.id === id)?.mask;
                  if (!now) {
                    e.setView({ maskOpen: true });
                    commit((p) => updateMask(p, kind, id, {}), `${title}: mask added`);
                  } else e.setView({ maskOpen: !(views[id] ?? DEFAULT_VIEW).maskOpen });
                }}
              />
            );
            return (
              <Module
                title={title}
                enabled={m?.enabled ?? false}
                modified={isInstanceModified(params, kind, id)}
                onToggle={(on) => commit((p) => updateInstance(p, kind, id, { enabled: on }))}
                onReset={() => commit((p) => resetInstance(p, kind, id))}
                menu={
                  <>
                    {PRESET_KINDS.includes(kind) && (
                      <PresetMenu
                        title={title}
                        presets={presets}
                        canSave={canSave}
                        onApply={(preset) =>
                          latest.current.onCommit(
                            applyModulePreset(endPreview(), kind, id, preset.payload as ModulePresetPayload<K>),
                            `${title}: preset ${preset.name}`,
                          )
                        }
                        onPreview={(preset) =>
                          preview(
                            preset && ((p) => applyModulePreset(p, kind, id, preset.payload as ModulePresetPayload<K>)),
                          )
                        }
                        onEndPreview={endPreview}
                        onSave={() => setSavingPreset({ kind, id, title })}
                        onDelete={(preset) => latest.current.onDeletePreset(preset)}
                      />
                    )}
                    {!SINGLE_INSTANCE_KINDS.includes(kind) && (
                      <InstanceMenu
                        title={title}
                        position={position}
                        count={count}
                        disabled={!m}
                        onAction={(action) => {
                          if (action === 'new') commit((p) => addInstance(p, id));
                          else if (action === 'rename') setRenaming(id);
                          else if (action === 'up') commit((p) => moveInstance(p, id, -1));
                          else if (action === 'down') commit((p) => moveInstance(p, id, 1));
                          else commit((p) => removeInstance(p, id));
                        }}
                      />
                    )}
                  </>
                }
                actions={
                  <>
                    {maskButton}
                    {actions?.(e)}
                  </>
                }
              >
                {content(e)}
                {mask && e.view.maskOpen && (
                  <MaskEditor
                    kind={kind}
                    id={id}
                    mask={mask}
                    shapeTypes={maskTypes ?? []}
                    ui={shapeUi}
                    params={() => latest.current.params}
                    title={() => {
                      const now = latest.current.params.modules.find((x) => x.id === id);
                      return now ? instanceTitle(latest.current.params, now) : MODULE_TITLES[kind];
                    }}
                    onChange={(p) => latest.current.onChange(p)}
                    onCommit={(p, label) => latest.current.onCommit(p, label)}
                    onUi={(patch) => latest.current.onShapeUi(patch)}
                    remembered={e.view.maskRanges}
                    onRemember={(key, range) =>
                      setViews((v) => {
                        const view = { ...DEFAULT_VIEW, ...v[id] };
                        return { ...v, [id]: { ...view, maskRanges: { ...view.maskRanges, [key]: range } } };
                      })
                    }
                  />
                )}
              </Module>
            );
          }}
        />
      );
    });
  }

  // What the retouch section shows of the spots' shapes: their types, and the selected
  // one's feather. Not the shapes themselves, which change on every move of a spot drag.
  const retouchShapes = (() => {
    const types = params.modules
      .flatMap((m) => (m.kind === 'retouch' ? [m.params.spots.map((x) => params.shapes?.[x.shape]?.type).join()] : []))
      .join('|');
    const edited = params.modules.find((m) => m.id === shapeUi.instance);
    const id =
      edited?.kind === 'retouch' && shapeUi.selected !== null
        ? edited.params.spots[shapeUi.selected]?.shape
        : undefined;
    const selected = id === undefined ? undefined : params.shapes?.[id];
    return `${types}/${selected && selected.type !== 'brush' ? selected.feather : ''}`;
  })();

  // Lens correction strengths: 0 … 200 % of the camera's correction.
  const percent = { min: 0, max: 2, step: 0.01, scale: 100, format: (v: number) => `${Math.round(v * 100)} %` };

  /** Props for a slider bound to one field of a colour primary. */
  function bindPrimary(e: ReturnType<typeof editor<'colorPrimaries'>>, name: PrimaryName, key: keyof Primary) {
    const with_ = (v: number) => e.edit({ [name]: { ...e.current()[name], [key]: v } });
    return {
      value: e.values[name][key],
      defaultValue: defaultModuleParams.colorPrimaries[name][key],
      onChange: (v: number) => latest.current.onChange(with_(v)),
      onCommit: (v: number) => latest.current.onCommit(with_(v)),
    };
  }

  /** Props for a slider bound to one end of a tone curve's node range. */
  function bindToneRange(e: ReturnType<typeof editor<'toneCurve'>>, i: 0 | 1) {
    const with_ = (v: number) => e.edit({ range: e.current().range.map((r, j) => (j === i ? v : r)) });
    return {
      value: e.values.range[i]!,
      defaultValue: e.defaults.range[i]!,
      onChange: (v: number) => latest.current.onChange(with_(v)),
      onCommit: (v: number) => latest.current.onCommit(with_(v)),
    };
  }

  type CalibrationEditor = ReturnType<typeof editor<'colorCalibration'>>;
  type Channels = 'red' | 'green' | 'blue' | 'colorfulness' | 'brightness' | 'grey';

  /** Props for a slider bound to one coefficient of a colour calibration array. */
  function bindChannel(e: CalibrationEditor, key: Channels, i: number) {
    const with_ = (v: number) => e.edit({ [key]: e.current()[key].map((c, j) => (j === i ? v : c)) });
    return {
      value: e.values[key][i]!,
      defaultValue: e.defaults[key][i]!,
      onChange: (v: number) => latest.current.onChange(with_(v)),
      onCommit: (v: number) => latest.current.onCommit(with_(v)),
    };
  }

  /**
   * The custom illuminant's hue and chroma. Without chroma the light has no hue: the last
   * one set is kept, so that the hue can be chosen before the chroma.
   */
  function hueChroma(id: string, p: Calibration) {
    const hc = xyToHueChroma([p.x, p.y]);
    return hc.chroma < 0.05 ? { hue: angles.current[id]?.illuminantHue ?? 0, chroma: 0 } : hc;
  }

  /** Props for the custom illuminant's hue (degrees) or chroma sliders, which set its x and y. */
  function bindHueChroma(e: CalibrationEditor, key: 'hue' | 'chroma') {
    const with_ = (v: number) => {
      const hc = { ...hueChroma(e.id, e.current()), [key]: v };
      setAngle(e.id, 'illuminantHue', hc.hue);
      const [x, y] = hueChromaToXy(hc.hue, hc.chroma).map((c) => Math.round(c * 1e4) / 1e4) as Xy;
      return e.edit({ x, y });
    };
    return {
      value: hueChroma(e.id, e.values)[key],
      defaultValue: key === 'hue' ? 0 : xyToHueChroma([e.defaults.x, e.defaults.y]).chroma,
      onChange: (v: number) => latest.current.onChange(with_(v)),
      onCommit: (v: number) => latest.current.onCommit(with_(v)),
    };
  }

  /**
   * Props for a slider of a mixer primaries mode. The recipe keeps the matrix: the value
   * is read from it, and a change rebuilds it (a degenerate mix is ignored, as in Ansel).
   */
  function bindMixer(e: CalibrationEditor, mode: MixerMode, key: MixerKey) {
    const { write, identity } = MIXER_MODES[mode];
    const with_ = (v: number) => {
      const p = e.current();
      const next = mixerValues(e.id, mode, p);
      if (!next) return latest.current.params;
      next[key] = v;
      // Remember the angles, so that one survives its magnitude going through zero.
      for (const [angle] of MIXER_ANGLES[mode]) setAngle(e.id, `${mode}.${angle}`, next[angle]);
      const m = write(mixerWhite(p), next as never);
      return m ? e.edit(mixerRows(m)) : latest.current.params;
    };
    const values = (p: Calibration) => mixerValues(e.id, mode, p);
    const defaultValue = (identity as Record<MixerKey, number>)[key];
    return {
      value: values(e.values)?.[key] ?? defaultValue,
      defaultValue,
      onChange: (v: number) => latest.current.onChange(with_(v)),
      onCommit: (v: number) => latest.current.onCommit(with_(v)),
    };
  }

  /** A mixer mode's values for an instance, with the remembered angles where they are undefined. */
  function mixerValues(id: string, mode: MixerMode, p: Calibration) {
    const values = MIXER_MODES[mode].read(mixerWhite(p), mixerMatrix(p)) as Record<MixerKey, number> | null;
    if (!values) return null;
    for (const [angle, magnitude, zero] of MIXER_ANGLES[mode]) {
      if (Math.abs(values[magnitude] - zero) < ZERO_MAGNITUDE)
        values[angle] = angles.current[id]?.[`${mode}.${angle}`] ?? 0;
    }
    return values;
  }

  /** A "normalize" switch for a colour calibration page. */
  const normalizeSwitch = (e: CalibrationEditor, page: Channels, hint: string) => {
    const key = NORMALIZE_KEYS[page];
    return (
      <Switch.Root
        size="xs"
        colorPalette="orange"
        checked={e.values[key]}
        onCheckedChange={(d) => e.set({ [key]: d.checked })}
        title={hint}
      >
        <Switch.HiddenInput />
        <Switch.Control />
        <Switch.Label textStyle="2xs" color="fg.muted">
          Normalize
        </Switch.Label>
      </Switch.Root>
    );
  };

  /** Props for the slider that steps through filmic's bleach levels. */
  const bindBleach = (e: ReturnType<typeof editor<'filmic'>>) => {
    const with_ = (i: number) => e.edit({ bleach: BLEACH_LEVELS[i]! });
    return {
      value: BLEACH_LEVELS.indexOf(e.values.bleach),
      defaultValue: BLEACH_LEVELS.indexOf(defaultModuleParams.filmic.bleach),
      onChange: (i: number) => latest.current.onChange(with_(i)),
      onCommit: (i: number) => latest.current.onCommit(with_(i)),
    };
  };

  // A drag on a filmic range slider works from the values it started with, so that a
  // clamped white or black doesn't drift.
  const rangeDrag = useRef<{ id: string; key: keyof FilmicRange; from: FilmicRange } | null>(null);

  /** Props for filmic's white, black and dynamic range scaling sliders, which move each other. */
  const bindRange = (e: ReturnType<typeof editor<'filmic'>>, key: keyof FilmicRange) => {
    const with_ = (v: number, done: boolean) => {
      const drag = rangeDrag.current;
      const from = drag && drag.id === e.id && drag.key === key ? drag.from : pickRange(e.current());
      rangeDrag.current = done ? null : { id: e.id, key, from };
      return e.edit(moveRange(from, key, v));
    };
    return {
      value: e.values[key],
      defaultValue: e.defaults[key],
      onChange: (v: number) => latest.current.onChange(with_(v, false)),
      onCommit: (v: number) => latest.current.onCommit(with_(v, true)),
    };
  };

  return (
    <Box px="3">
      {sections('exposure', [], (e) => (
        <>
          <ParamSlider
            label="Exposure"
            min={-4}
            max={4}
            hardMin={-10}
            hardMax={10}
            step={0.05}
            format={fmt.ev}
            track={tracks.grey}
            {...e.bind('ev')}
          />
          <ParamSlider
            label="Black level"
            min={0}
            max={0.1}
            hardMax={1}
            step={0.001}
            format={(v) => v.toFixed(3)}
            {...e.bind('black')}
          />
        </>
      ))}

      {sections('colorCalibration', [asShotIlluminant, detecting], (e) => {
        const page = e.view.calibration;
        const v = e.values;
        const light = illuminantXy(v, asShotIlluminant);
        const asShotStart = v.illuminant === 'asShot' ? asShotTemperature(asShotIlluminant) : null;
        // Handlers read the instance and the as-shot light when called (sliders keep their first ones).
        const temperaturePatch = (t: number) => setTemperature(e.current(), t, latest.current.asShotIlluminant);
        const adapts = v.illuminant === 'asShot' || v.adaptation !== 'none';
        const white = mixerWhite(v);
        const matrix = mixerMatrix(v);
        const modified = (p: CalibrationPage) =>
          CALIBRATION_PAGE_KEYS[p].some((k) => JSON.stringify(v[k]) !== JSON.stringify(e.defaults[k]));
        return (
          <>
            {/* Tabs, not a select: they choose what the panel shows, not the image. */}
            <Tabs.Root
              size="sm"
              variant="line"
              value={page}
              onValueChange={(d) => e.setView({ calibration: d.value as CalibrationPage })}
            >
              <Tabs.List aria-label="Color calibration tabs" gap="0">
                {CALIBRATION_PAGES.map((p) => (
                  <Tabs.Trigger
                    key={p}
                    value={p}
                    title={CALIBRATION_PAGE_TITLES[p]}
                    h="7"
                    px="1.5"
                    flex="auto"
                    justifyContent="center"
                    textStyle="2xs"
                    position="relative"
                  >
                    {CALIBRATION_PAGE_LABELS[p]}
                    {modified(p) && (
                      <Box
                        position="absolute"
                        top="1"
                        right="0.5"
                        boxSize="1"
                        borderRadius="full"
                        bg="orange.solid"
                        aria-label="modified"
                      />
                    )}
                  </Tabs.Trigger>
                ))}
              </Tabs.List>
            </Tabs.Root>
            {page === 'illuminant' && (
              <>
                <SelectRow label="Adaptation">
                  {(id) => (
                    <NativeSelect.Root size="xs" flex="1" disabled={v.illuminant === 'asShot'}>
                      <NativeSelect.Field
                        id={id}
                        value={v.illuminant === 'asShot' ? 'cat16' : v.adaptation}
                        onChange={(ev) => e.set({ adaptation: ev.target.value as Adaptation })}
                        title="Chromatic adaptation transform (as shot always uses CAT16)"
                      >
                        {ADAPTATIONS.map((a) => (
                          <option key={a} value={a}>
                            {ADAPTATION_LABELS[a]}
                          </option>
                        ))}
                      </NativeSelect.Field>
                      <NativeSelect.Indicator />
                    </NativeSelect.Root>
                  )}
                </SelectRow>
                {adapts && (
                  <>
                    <HStack gap="1.5">
                      <SelectRow label="Illuminant">
                        {(id) => (
                          <NativeSelect.Root size="xs" flex="1">
                            <NativeSelect.Field
                              id={id}
                              value={v.illuminant}
                              onChange={(ev) =>
                                e.set(switchIlluminant(e.current(), ev.target.value as Illuminant, asShotIlluminant))
                              }
                            >
                              {ILLUMINANTS.map((i) => (
                                <option key={i} value={i}>
                                  {ILLUMINANT_LABELS[i]}
                                </option>
                              ))}
                            </NativeSelect.Field>
                            <NativeSelect.Indicator />
                          </NativeSelect.Root>
                        )}
                      </SelectRow>
                      <Menu.Root
                        lazyMount
                        unmountOnExit
                        onSelect={(d) => latest.current.onDetectIlluminant(e.id, d.value as IlluminantDetection)}
                      >
                        <Menu.Trigger asChild>
                          <IconButton
                            aria-label="Detect the illuminant"
                            title="Detect the light from the image (like Ansel's AI detection)"
                            size="2xs"
                            variant="outline"
                            disabled={!e.enabled}
                            loading={detecting === e.id}
                          >
                            <Pipette />
                          </IconButton>
                        </Menu.Trigger>
                        <Portal>
                          <Menu.Positioner>
                            <Menu.Content minW="48">
                              <Menu.Item value="surfaces">Detect from surfaces</Menu.Item>
                              <Menu.Item value="edges">Detect from edges</Menu.Item>
                            </Menu.Content>
                          </Menu.Positioner>
                        </Portal>
                      </Menu.Root>
                    </HStack>
                    {/* Under "as shot" too, at the camera light's temperature: dragging it
                        switches to daylight or black body. The same slider stays mounted
                        through the switch, so the drag goes on. */}
                    {(v.illuminant === 'daylight' || v.illuminant === 'blackBody' || asShotStart) && (
                      <ParamSlider
                        label="Temperature"
                        min={TEMPERATURE_SOFT[0]}
                        max={TEMPERATURE_SOFT[1]}
                        hardMin={TEMPERATURE_MIN}
                        hardMax={TEMPERATURE_MAX}
                        step={10}
                        track={TEMPERATURE_TRACK}
                        format={(t) => `${t.toFixed(0)} K`}
                        {...e.bind('temperature')}
                        value={asShotStart?.temperature ?? v.temperature}
                        onChange={(t) => latest.current.onChange(e.edit(temperaturePatch(t)))}
                        onCommit={(t) => latest.current.onCommit(e.edit(temperaturePatch(t)))}
                      />
                    )}
                    {v.illuminant === 'fluorescent' && (
                      <NativeSelect.Root size="xs">
                        <NativeSelect.Field
                          value={v.fluorescent}
                          onChange={(ev) => e.set({ fluorescent: ev.target.value as Fluorescent })}
                          aria-label="Fluorescent illuminant"
                        >
                          {FLUORESCENTS.map((f) => (
                            <option key={f} value={f}>
                              {FLUORESCENT_LABELS[f]}
                            </option>
                          ))}
                        </NativeSelect.Field>
                        <NativeSelect.Indicator />
                      </NativeSelect.Root>
                    )}
                    {v.illuminant === 'led' && (
                      <NativeSelect.Root size="xs">
                        <NativeSelect.Field
                          value={v.led}
                          onChange={(ev) => e.set({ led: ev.target.value as Led })}
                          aria-label="LED illuminant"
                        >
                          {LEDS.map((l) => (
                            <option key={l} value={l}>
                              {LED_LABELS[l]}
                            </option>
                          ))}
                        </NativeSelect.Field>
                        <NativeSelect.Indicator />
                      </NativeSelect.Root>
                    )}
                    {v.illuminant === 'custom' && (
                      <>
                        <ParamSlider
                          label="Hue"
                          min={0}
                          max={360}
                          step={1}
                          track={tracks.hue(180)}
                          format={(h) => `${h.toFixed(0)}°`}
                          {...bindHueChroma(e, 'hue')}
                        />
                        <ParamSlider
                          label="Chroma"
                          min={0}
                          max={100}
                          hardMax={200}
                          step={0.5}
                          format={(c) => c.toFixed(1)}
                          {...bindHueChroma(e, 'chroma')}
                        />
                      </>
                    )}
                  </>
                )}
                <Button
                  size="2xs"
                  variant="ghost"
                  alignSelf="start"
                  px="0"
                  onClick={() => e.setView({ calibrationAdvanced: !e.view.calibrationAdvanced })}
                >
                  {e.view.calibrationAdvanced ? <ChevronDown /> : <ChevronRight />} Gamut handling
                </Button>
                {e.view.calibrationAdvanced && (
                  <>
                    <ParamSlider
                      label="Gamut compression"
                      min={0}
                      max={5}
                      hardMax={12}
                      step={0.01}
                      format={fmt.fixed2}
                      {...e.bind('gamut')}
                    />
                    <Switch.Root
                      size="xs"
                      colorPalette="orange"
                      checked={v.clip}
                      onCheckedChange={(d) => e.set({ clip: d.checked })}
                    >
                      <Switch.HiddenInput />
                      <Switch.Control />
                      <Switch.Label textStyle="2xs" color="fg.muted">
                        Clip negative RGB from gamut
                      </Switch.Label>
                    </Switch.Root>
                  </>
                )}
              </>
            )}
            {page === 'mixer' && (
              <HStack gap="2" alignItems="baseline">
                <Text textStyle="2xs" color="fg.subtle" flexShrink={0}>
                  Edit as
                </Text>
                <Tabs.Root
                  size="sm"
                  variant="subtle"
                  value={e.view.mixer}
                  onValueChange={(d) => e.setView({ mixer: d.value as MixerView })}
                >
                  <Tabs.List aria-label="Mixer view" gap="0.5" minH="0" p="0" alignItems="center">
                    {MIXER_VIEWS.map((m) => (
                      <Tabs.Trigger key={m} value={m} title={MIXER_VIEW_TITLES[m]} h="5" px="1.5" textStyle="2xs">
                        {MIXER_VIEW_LABELS[m]}
                      </Tabs.Trigger>
                    ))}
                  </Tabs.List>
                </Tabs.Root>
              </HStack>
            )}
            {page === 'mixer' && e.view.mixer === 'primaries' && !primariesFromMatrix(white, matrix) && (
              <Text textStyle="2xs" color="fg.subtle">
                This mix is singular, so it can’t be shown as primaries. Edit it as channels, or reset the module.
              </Text>
            )}
            {page === 'mixer' && e.view.mixer === 'primaries' && primariesFromMatrix(white, matrix) && (
              <>
                <ParamSlider
                  key="primaries-whiteHue"
                  label="White hue"
                  min={-180}
                  max={180}
                  step={0.5}
                  track={tracks.hue(0)}
                  format={degrees}
                  {...bindMixer(e, 'primaries', 'whiteHue')}
                />
                <ParamSlider
                  key="primaries-whitePurity"
                  label="White purity"
                  min={0}
                  max={0.1}
                  hardMax={2}
                  step={0.0005}
                  format={(p) => p.toFixed(4)}
                  {...bindMixer(e, 'primaries', 'whitePurity')}
                />
                {CHANNELS.map((c, i) => {
                  const name = c.toLowerCase() as 'red' | 'green' | 'blue';
                  return (
                    <Fragment key={name}>
                      <ParamSlider
                        key={`primaries-${name}Hue`}
                        label={`${c} hue`}
                        min={-90}
                        max={90}
                        hardMin={-180}
                        hardMax={180}
                        step={0.5}
                        curve={HUE_CURVE}
                        track={tracks.hueQuarter(PRIMARY_CSS_HUES[i]!, HUE_CURVE)}
                        format={degrees}
                        {...bindMixer(e, 'primaries', `${name}Hue`)}
                      />
                      <ParamSlider
                        key={`primaries-${name}Purity`}
                        label={`${c} purity`}
                        min={0}
                        max={2}
                        step={0.01}
                        track={tracks.saturation(PRIMARY_CSS_HUES[i]!)}
                        format={fmt.fixed2}
                        {...bindMixer(e, 'primaries', `${name}Purity`)}
                      />
                    </Fragment>
                  );
                })}
                <ParamSlider
                  key="primaries-gain"
                  label="Gain"
                  min={0}
                  max={2}
                  hardMin={-8}
                  hardMax={8}
                  step={0.01}
                  track={tracks.grey}
                  format={fmt.fixed2}
                  {...bindMixer(e, 'primaries', 'gain')}
                />
              </>
            )}
            {page === 'mixer' &&
              e.view.mixer === 'whitePreserving' &&
              !whitePreservingFromMatrix(white, matrix) &&
              (() => {
                const clamped = withoutWhiteShift(white, matrix);
                return (
                  <>
                    <Text textStyle="2xs" color="fg.subtle">
                      This mix also shifts the white (a tint or a brightness change), which white-preserving primaries
                      can’t show.
                      {clamped && ' Removing the shift keeps each primary’s hue and saturation.'}
                    </Text>
                    {clamped && (
                      <Button size="2xs" variant="outline" alignSelf="start" onClick={() => e.set(mixerRows(clamped))}>
                        Remove the white shift
                      </Button>
                    )}
                  </>
                );
              })()}
            {page === 'mixer' && e.view.mixer === 'whitePreserving' && whitePreservingFromMatrix(white, matrix) && (
              <>
                {CHANNELS.map((c, i) => {
                  const name = c.toLowerCase() as 'red' | 'green' | 'blue';
                  return (
                    <Fragment key={name}>
                      <ParamSlider
                        key={`whitePreserving-${name}Rotation`}
                        label={`${c} rotation`}
                        min={-90}
                        max={90}
                        hardMin={-180}
                        hardMax={180}
                        step={0.5}
                        track={tracks.hueQuarter(PRIMARY_CSS_HUES[i]!)}
                        format={degrees}
                        {...bindMixer(e, 'whitePreserving', `${name}Rotation`)}
                      />
                      <ParamSlider
                        key={`whitePreserving-${name}Saturation`}
                        label={`${c} saturation`}
                        min={-1}
                        max={1}
                        hardMax={2}
                        step={0.01}
                        track={tracks.saturation(PRIMARY_CSS_HUES[i]!)}
                        {...bindMixer(e, 'whitePreserving', `${name}Saturation`)}
                      />
                    </Fragment>
                  );
                })}
              </>
            )}
            {page === 'mixer' &&
              e.view.mixer === 'channels' &&
              (['red', 'green', 'blue'] as const).map((row, r) => (
                <Fragment key={row}>
                  <HStack justify="space-between" pt={r ? '1' : '0'}>
                    <Text textStyle="2xs" fontWeight="medium" color="fg.muted">
                      {CHANNELS[r]} output
                    </Text>
                    {normalizeSwitch(e, row, 'Scale the coefficients so that they add up to 1 (greys stay grey)')}
                  </HStack>
                  {CHANNELS.map((c, i) => (
                    <ParamSlider
                      key={`channels-${row}-${i}`}
                      label={`Input ${c.toLowerCase()}`}
                      min={-2}
                      max={2}
                      step={0.01}
                      track={CHANNEL_TRACKS[i]}
                      format={fmt.fixed2}
                      {...bindChannel(e, row, i)}
                    />
                  ))}
                </Fragment>
              ))}
            {page === 'output' &&
              OUTPUT_GROUPS.map((g, r) => (
                <Fragment key={g.key}>
                  <HStack justify="space-between" pt={r ? '1' : '0'}>
                    <Text textStyle="2xs" fontWeight="medium" color="fg.muted">
                      {g.title}
                    </Text>
                    {normalizeSwitch(e, g.key, g.hint)}
                  </HStack>
                  {CHANNELS.map((c, i) => (
                    <ParamSlider
                      key={`output-${g.key}-${i}`}
                      label={c}
                      min={g.min}
                      max={g.max}
                      hardMin={g.hardMin}
                      hardMax={g.hardMax}
                      step={0.01}
                      track={CHANNEL_TRACKS[i]}
                      format={fmt.fixed2}
                      {...bindChannel(e, g.key, i)}
                    />
                  ))}
                </Fragment>
              ))}
          </>
        );
      })}

      {sections('color', [], (e) => (
        <>
          <ParamSlider label="Saturation" min={-1} max={1} step={0.01} {...e.bind('saturation')} />
          <ParamSlider label="Vibrance" min={-1} max={1} step={0.01} {...e.bind('vibrance')} />
        </>
      ))}

      {sections('shadowsHighlights', [], (e) => (
        <>
          <ParamSlider label="Shadows" min={-1} max={1} step={0.01} track={tracks.grey} {...e.bind('shadows')} />
          <ParamSlider label="Highlights" min={-1} max={1} step={0.01} track={tracks.grey} {...e.bind('highlights')} />
        </>
      ))}

      {sections('colorPrimaries', [], (e) => (
        <>
          <HStack gap="1" justify="space-between" role="radiogroup" aria-label="Primary">
            {PRIMARIES.map((name) => {
              const p = e.values[name];
              const edited = p.hue !== 0 || p.saturation !== 0 || p.brightness !== 0;
              return (
                <Box
                  key={name}
                  as="button"
                  role="radio"
                  aria-checked={e.view.primary === name}
                  aria-label={name}
                  title={name}
                  flex="1"
                  h="5"
                  borderRadius="sm"
                  bg={PRIMARY_SWATCHES[name]}
                  cursor="pointer"
                  position="relative"
                  outline={e.view.primary === name ? '2px solid' : 'none'}
                  outlineColor="fg"
                  outlineOffset="1px"
                  onClick={() => e.setView({ primary: name })}
                >
                  {edited && (
                    <Box
                      position="absolute"
                      top="1"
                      right="1"
                      boxSize="1.5"
                      borderRadius="full"
                      bg="white"
                      boxShadow="xs"
                    />
                  )}
                </Box>
              );
            })}
          </HStack>
          <ParamSlider
            key={`${e.view.primary}-hue`}
            label="Hue"
            min={-180}
            max={180}
            step={1}
            track={tracks.hue(PRIMARY_HUES[e.view.primary])}
            format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(0)}°`}
            {...bindPrimary(e, e.view.primary, 'hue')}
          />
          <ParamSlider
            key={`${e.view.primary}-saturation`}
            label="Saturation"
            min={-100}
            max={100}
            step={1}
            track={tracks.saturation(PRIMARY_HUES[e.view.primary])}
            format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(0)} %`}
            {...bindPrimary(e, e.view.primary, 'saturation')}
          />
          <ParamSlider
            key={`${e.view.primary}-brightness`}
            label="Brightness"
            min={-0.25}
            max={0.25}
            hardMin={-1}
            hardMax={1}
            step={0.005}
            scale={100}
            track={tracks.brightness(PRIMARY_HUES[e.view.primary])}
            format={(v) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)} %`}
            {...bindPrimary(e, e.view.primary, 'brightness')}
          />
          <Button
            size="2xs"
            variant="ghost"
            alignSelf="start"
            px="0"
            onClick={() => e.setView({ primariesAdvanced: !e.view.primariesAdvanced })}
          >
            {e.view.primariesAdvanced ? <ChevronDown /> : <ChevronRight />} Gamut and smoothing
          </Button>
          {e.view.primariesAdvanced && (
            <>
              <ParamSlider
                label="White level"
                min={-2}
                max={16}
                step={0.05}
                format={fmt.ev}
                {...e.bind('whiteLevel')}
              />
              <ParamSlider
                label="Gamut coverage"
                min={0}
                max={100}
                step={0.5}
                format={(v) => `${v.toFixed(1)} %`}
                {...e.bind('gamutCoverage')}
              />
              <ParamSlider
                label="Neutral protection"
                min={0}
                max={2}
                step={0.01}
                format={fmt.fixed2}
                {...e.bind('neutralProtection')}
              />
              <ParamSlider
                label="Brightness smoothing"
                min={1}
                max={100}
                step={0.5}
                format={(v) => `${v.toFixed(1)} %`}
                {...e.bind('brightnessSmoothing')}
              />
              <ParamSlider
                label="Saturation smoothing"
                min={0.01}
                max={2}
                step={0.01}
                format={fmt.fixed2}
                {...e.bind('saturationSmoothing')}
              />
              <ParamSlider
                label="Hue smoothing"
                min={0.01}
                max={6.28}
                step={0.01}
                scale={180 / Math.PI}
                format={(v) => `${((v * 180) / Math.PI).toFixed(0)}°`}
                {...e.bind('hueSmoothing')}
              />
            </>
          )}
        </>
      ))}

      {sections('toneCurve', [toneInputs, fittingTone, toneView], (e) => {
        const v = e.values;
        const independent = v.channels === 'independent';
        const key = independent ? e.view.toneChannel : 'rgb';
        const channel = TONE_CHANNELS.indexOf(e.view.toneChannel);
        const range = toneCurveRange(v);
        const input = toneInputs[e.id];
        const bins = input?.bins.length === 3 ? input.bins[channel] : input?.bins[0];
        const showing = toneView?.id === e.id;
        /** Update the overlay, if it shows this instance. */
        const updateView = (patch: Partial<ToneCurveView>) => {
          const now = latest.current.toneView;
          if (now?.id === e.id) latest.current.onToneView({ ...now, ...patch });
        };
        const others = independent
          ? TONE_CHANNELS.filter((c) => c !== key).map((c) => ({
              values: toneToUnit(v[c]),
              color: TONE_CHANNEL_COLORS[c],
            }))
          : [];
        return (
          <>
            <HStack gap="2">
              <NativeSelect.Root size="xs" flex="1">
                <NativeSelect.Field
                  value={v.channels}
                  onChange={(ev) => e.set({ channels: ev.target.value as ModuleParams['toneCurve']['channels'] })}
                  aria-label="Channels"
                >
                  <option value="linked">RGB, linked</option>
                  <option value="independent">RGB, independent</option>
                </NativeSelect.Field>
                <NativeSelect.Indicator />
              </NativeSelect.Root>
              {!independent && (
                <NativeSelect.Root size="xs" flex="1">
                  <NativeSelect.Field
                    value={v.preserveColors}
                    onChange={(ev) => e.set({ preserveColors: ev.target.value as RgbNorm })}
                    aria-label="Preserve colors"
                    title="Preserve colors: what the curve reads; the pixel is scaled as a whole, keeping its hue and saturation"
                  >
                    {RGB_NORMS.map((n) => (
                      <option key={n} value={n}>
                        {RGB_NORM_LABELS[n]}
                      </option>
                    ))}
                  </NativeSelect.Field>
                  <NativeSelect.Indicator />
                </NativeSelect.Root>
              )}
              <IconButton
                aria-label="Fit the nodes to the image"
                title="Fit the nodes to the image: spread them from its darkest to its brightest tones"
                size="2xs"
                variant="outline"
                loading={fittingTone === e.id}
                onClick={() => latest.current.onFitToneCurve(e.id)}
              >
                <WandSparkles />
              </IconButton>
              <IconButton
                aria-label={showing ? 'Hide what the curve reads' : 'Show what the curve reads on the image'}
                title="Show what the curve reads on the image: black at the darkest node, white at the brightest; the selected node's tones in yellow"
                size="2xs"
                variant={showing ? 'subtle' : 'outline'}
                colorPalette={showing ? 'orange' : 'gray'}
                aria-pressed={showing}
                disabled={!e.enabled}
                onClick={() =>
                  latest.current.onToneView(showing ? null : { id: e.id, channel: Math.max(0, channel), node: null })
                }
              >
                <Eye />
              </IconButton>
            </HStack>
            {independent && (
              <Tabs.Root
                size="sm"
                variant="subtle"
                value={e.view.toneChannel}
                onValueChange={(d) => {
                  e.setView({ toneChannel: d.value as ToneChannel });
                  updateView({ channel: TONE_CHANNELS.indexOf(d.value as ToneChannel), node: null });
                }}
              >
                <Tabs.List aria-label="Channel" gap="0.5" minH="0" p="0" alignItems="center">
                  {TONE_CHANNELS.map((c) => (
                    <Tabs.Trigger key={c} value={c} h="5" px="1.5" textStyle="2xs" textTransform="capitalize">
                      <Box boxSize="2" borderRadius="full" bg={TONE_CHANNEL_COLORS[c]} />
                      {c}
                    </Tabs.Trigger>
                  ))}
                </Tabs.List>
              </Tabs.Root>
            )}
            <CurveEditor
              key={key}
              label={independent ? `Tone curve, ${key}` : 'Tone curve'}
              values={toneToUnit(v[key])}
              defaults={TONE_FLAT}
              neutral={0.5}
              left={signedEv(range[0])}
              right={signedEv(range[1])}
              histogram={bins && toneHistogram(bins, range)}
              onFocusChange={(node) => updateView({ node })}
              color={independent ? TONE_CHANNEL_COLORS[key as ToneChannel] : undefined}
              others={others}
              format={(i, value) => `${signedEv(toneNodeEv(i, range))}: ${signedEv(toneFromUnit([value])[0]!)}`}
              onChange={(values) => latest.current.onChange(e.edit({ [key]: toneFromUnit(values) }))}
              onCommit={(values) => e.set({ [key]: toneFromUnit(values) })}
            />
            <ParamSlider
              label="Darkest node"
              min={-14}
              max={0}
              hardMin={-16}
              hardMax={8}
              step={0.1}
              format={fmt.ev}
              track={tracks.grey}
              {...bindToneRange(e, 0)}
            />
            <ParamSlider
              label="Brightest node"
              min={-2}
              max={8}
              hardMin={-16}
              hardMax={8}
              step={0.1}
              format={fmt.ev}
              track={tracks.grey}
              {...bindToneRange(e, 1)}
            />
          </>
        );
      })}

      {sections('contrastEqualizer', [], (e) => (
        <>
          <NativeSelect.Root size="xs">
            <NativeSelect.Field
              value={e.view.curve}
              onChange={(ev) => e.setView({ curve: ev.target.value as EqualizerCurve })}
              aria-label="Curve"
            >
              {EQUALIZER_CURVES.map((c) => (
                <option key={c} value={c}>
                  {EQUALIZER_LABELS[c]}
                </option>
              ))}
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
          <CurveEditor
            label={EQUALIZER_LABELS[e.view.curve]}
            values={e.values[e.view.curve]}
            defaults={defaultModuleParams.contrastEqualizer[e.view.curve]}
            neutral={defaultModuleParams.contrastEqualizer[e.view.curve][0]!}
            left="coarse"
            right="fine"
            onChange={(v) => latest.current.onChange(e.edit({ [e.view.curve]: v }))}
            onCommit={(v) => e.set({ [e.view.curve]: v })}
          />
          <ParamSlider label="Mix" min={-2} max={2} step={0.01} format={fmt.fixed2} {...e.bind('mix')} />
        </>
      ))}

      {sections(
        'filmic',
        [autoTuning],
        (e) => (
          <>
            <ParamSlider
              label="White relative exposure"
              min={1}
              max={10}
              hardMin={0.1}
              hardMax={16}
              step={0.05}
              format={fmt.ev}
              track={tracks.grey}
              {...bindRange(e, 'whiteExposure')}
            />
            <ParamSlider
              label="Black relative exposure"
              min={-14}
              max={-3}
              hardMin={-16}
              hardMax={-0.1}
              step={0.05}
              format={fmt.ev}
              track={tracks.grey}
              {...bindRange(e, 'blackExposure')}
            />
            <ParamSlider
              label="Dynamic range scaling"
              min={-50}
              max={200}
              step={1}
              origin={0}
              format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(0)} %`}
              {...bindRange(e, 'dynamicRangeScaling')}
            />
            <ParamSlider
              label="Contrast"
              min={0.5}
              max={3}
              hardMin={0}
              hardMax={5}
              step={0.01}
              format={fmt.fixed2}
              {...e.bind('contrast')}
            />
            <ParamSlider
              label="Toe"
              min={0}
              max={100}
              step={0.5}
              format={(v) => `${v.toFixed(1)} %`}
              {...e.bind('toe')}
            />
            <ParamSlider
              label="Shoulder"
              min={0}
              max={100}
              step={0.5}
              format={(v) => `${v.toFixed(1)} %`}
              {...e.bind('shoulder')}
            />
            <ParamSlider
              label="Hue preservation"
              min={-100}
              max={100}
              step={1}
              format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(0)} %`}
              {...e.bind('huePreservation')}
            />
            <ParamSlider
              label="AgX bleach"
              min={0}
              max={BLEACH_LEVELS.length - 1}
              step={1}
              detents
              format={(i) => BLEACH_LABELS[BLEACH_LEVELS[i]!]}
              {...bindBleach(e)}
            />
          </>
        ),
        (e) => (
          <IconButton
            aria-label="Auto-tune filmic"
            title="Auto-tune: set white and black relative exposure from the image"
            size="2xs"
            variant="ghost"
            disabled={!e.enabled}
            loading={autoTuning}
            onClick={() => latest.current.onAutoTuneFilmic()}
          >
            <WandSparkles />
          </IconButton>
        ),
      )}

      {sections('lut', [luts, missingLuts], (e) => {
        const current = e.values.lut;
        const known = current && [...luts.builtIn, ...luts.own].find((l) => l.id === current.id);
        const instance = params.modules.find((m) => m.id === e.id);
        const title = instance ? instanceTitle(params, instance) : MODULE_TITLES.lut;
        /** The recipe with this instance using `lut`. */
        const withLut = (p: EditParams, lut: LutChoice) =>
          updateInstance(p, 'lut', e.id, { enabled: true, params: { lut: { id: lut.id, name: lut.name } } });
        return (
          <Stack gap="2" py="1">
            <SelectRow label="LUT">
              {(id) => (
                <LutMenu
                  triggerId={id}
                  title={title}
                  current={current}
                  builtIn={luts.builtIn}
                  own={luts.own}
                  local={luts.local}
                  onPick={(lut) => latest.current.onCommit(withLut(endPreview(), lut), `${title}: ${lut.name}`)}
                  onPreview={(lut) => preview(lut === undefined ? null : (p) => withLut(p, lut))}
                  onEndPreview={endPreview}
                  onAdd={(file) =>
                    void latest.current.onAddLut(file).then((lut) => {
                      if (lut) commit((p) => withLut(p, lut), `${title}: ${lut.name}`);
                    })
                  }
                  onRemove={(lut) => latest.current.onRemoveLut(lut)}
                />
              )}
            </SelectRow>
            <SelectRow label="Interp.">
              {(id) => (
                <NativeSelect.Root size="xs" flex="1" title="How colours between the LUT’s nodes are computed">
                  <NativeSelect.Field
                    id={id}
                    value={e.values.interpolation}
                    onChange={(ev) => e.set({ interpolation: ev.target.value as LutInterpolation })}
                  >
                    {LUT_INTERPOLATIONS.map((i) => (
                      <option key={i} value={i}>
                        {INTERPOLATION_LABELS[i]}
                      </option>
                    ))}
                  </NativeSelect.Field>
                  <NativeSelect.Indicator />
                </NativeSelect.Root>
              )}
            </SelectRow>
            {current && missingLuts.has(current.id) && (
              <Text textStyle="xs" color="fg.warning">
                “{current.name || 'This LUT'}” isn’t available{luts.local ? ' in this browser' : ''}: add its file again
                to use it.
              </Text>
            )}
            {known?.credit && (
              <Text textStyle="2xs" color="fg.subtle">
                {known.credit}
              </Text>
            )}
          </Stack>
        );
      })}

      {sections('glow', [], (e) => (
        <>
          <ParamSlider
            label="Threshold"
            min={-4}
            max={5}
            hardMin={-8}
            hardMax={8}
            step={0.05}
            format={fmt.ev}
            track={tracks.grey}
            {...e.bind('threshold')}
          />
          <ParamSlider label="Threshold softness" {...percent} max={1} {...e.bind('softness')} />
          <ParamSlider
            label="Radius"
            min={0}
            max={500}
            hardMax={2000}
            step={1}
            curve={GLOW_RADIUS_CURVE}
            format={(v) => `${v.toFixed(0)} px`}
            {...e.bind('radius')}
          />
          <ParamSlider
            label="Falloff"
            min={-1}
            max={1}
            step={0.01}
            format={(v) =>
              v < -0.005 ? `tight ${Math.round(-v * 100)} %` : v > 0.005 ? `long ${Math.round(v * 100)} %` : 'even'
            }
            {...e.bind('falloff')}
          />
          <ParamSlider
            label="Strength"
            min={0}
            max={5}
            hardMax={20}
            step={0.05}
            format={fmt.fixed2}
            {...e.bind('strength')}
          />
          <ParamSlider
            label="Tint hue"
            min={-180}
            max={180}
            step={1}
            track={tracks.hue(0)}
            format={degrees}
            {...e.bind('hue')}
          />
          <ParamSlider
            label="Tint saturation"
            {...percent}
            max={1}
            track={tracks.saturation(e.values.hue)}
            {...e.bind('saturation')}
          />
        </>
      ))}

      {sections('sharpen', [], (e) => (
        <>
          <ParamSlider
            label="Amount"
            min={0}
            max={2}
            hardMax={5}
            step={0.01}
            format={fmt.fixed2}
            {...e.bind('amount')}
          />
          <ParamSlider
            label="Radius"
            min={0.3}
            max={5}
            step={0.05}
            format={(v) => `${v.toFixed(2)} px`}
            {...e.bind('radius')}
          />
        </>
      ))}

      {sections('blur', [], (e) => (
        <>
          <ParamSlider
            label="Radius"
            min={0}
            max={50}
            step={0.1}
            format={(v) => `${v.toFixed(1)} px`}
            {...e.bind('radius')}
          />
        </>
      ))}

      {sections('lens', [lensCorrection], (e) => (
        <>
          {!lensCorrection && (
            <Text textStyle="2xs" color="fg.subtle">
              This file has no lens correction data
            </Text>
          )}
          <ParamSlider label="Distortion" disabled={!lensCorrection} {...percent} {...e.bind('distortion')} />
          <ParamSlider label="Chromatic aberration" disabled={!lensCorrection} {...percent} {...e.bind('tca')} />
          <ParamSlider label="Vignetting" disabled={!lensCorrection} {...percent} {...e.bind('vignetting')} />
        </>
      ))}

      {sections('geometry', [cropping, aspect, guides, fittingPerspective], (e) => (
        <>
          <HStack justify="space-between">
            <ButtonGroup size="xs" variant="outline" attached>
              <IconButton aria-label="Rotate left" onClick={() => e.set({ rotation: (e.values.rotation + 3) % 4 })}>
                <RotateCcwSquare />
              </IconButton>
              <IconButton aria-label="Rotate right" onClick={() => e.set({ rotation: (e.values.rotation + 1) % 4 })}>
                <RotateCwSquare />
              </IconButton>
              <IconButton
                aria-label="Flip horizontally"
                variant={e.values.flipHorizontal ? 'solid' : 'outline'}
                onClick={() => e.set({ flipHorizontal: !e.values.flipHorizontal })}
              >
                <FlipHorizontal2 />
              </IconButton>
            </ButtonGroup>
            <Button
              size="xs"
              variant={cropping ? 'solid' : 'outline'}
              colorPalette={cropping ? 'orange' : 'gray'}
              onClick={() => latest.current.onStartCrop()}
            >
              <Crop /> {cropping ? 'Cropping…' : 'Crop'}
            </Button>
          </HStack>
          <ParamSlider
            label="Straighten"
            min={-45}
            max={45}
            step={0.1}
            format={(v) => `${v.toFixed(1)}°`}
            {...e.bind('angle')}
          />
          <PerspectiveTools
            guides={guides}
            fitting={fittingPerspective}
            onGuides={() => latest.current.onStartGuides()}
            onFit={(mode) => latest.current.onFitPerspective(mode)}
          />
          <ParamSlider label="Vertical" min={-40} max={40} step={0.1} format={degrees} {...e.bind('vertical')} />
          <ParamSlider label="Horizontal" min={-40} max={40} step={0.1} format={degrees} {...e.bind('horizontal')} />
          <ParamSlider
            label="Shear"
            min={-0.5}
            max={0.5}
            step={0.005}
            format={(v) => v.toFixed(3)}
            {...e.bind('shear')}
          />
          <ParamSlider label="Aspect" min={-1} max={1} step={0.01} format={fmt.fixed2} {...e.bind('aspect')} />
          <AutoCropSelect value={e.values.autoCrop} onChange={(autoCrop) => e.set({ autoCrop })} />
          <HStack>
            <SelectRow label="Aspect">
              {(id) => (
                <NativeSelect.Root size="xs" flex="1">
                  <NativeSelect.Field
                    id={id}
                    value={aspect.preset}
                    onChange={(e) => latest.current.onAspectChange(e.target.value)}
                  >
                    {ASPECTS.map((a) => (
                      <option key={a.value} value={a.value}>
                        {a.value === 'custom' ? a.label : aspectLabel(a.label, aspect.flipped)}
                      </option>
                    ))}
                  </NativeSelect.Field>
                  <NativeSelect.Indicator />
                </NativeSelect.Root>
              )}
            </SelectRow>
            <IconButton
              size="xs"
              variant="outline"
              aria-label="Swap crop width and height"
              title="Swap crop width and height"
              onClick={() => latest.current.onFlipAspect()}
            >
              <ArrowLeftRight />
            </IconButton>
            <Button
              size="xs"
              variant="ghost"
              disabled={!isCropped(e.values.crop)}
              onClick={() => e.set({ crop: { ...defaultModuleParams.geometry.crop } })}
            >
              Uncrop
            </Button>
          </HStack>
          {aspect.preset === 'custom' && (
            <Input
              // Uncontrolled, applied on Enter or blur: half-typed ratios would reshape the
              // crop. The key resets it when the ratio changes elsewhere (e.g. swapped).
              key={`${aspect.custom}-${aspect.flipped}`}
              size="xs"
              variant="subtle"
              defaultValue={aspect.flipped ? flipRatioText(aspect.custom) : aspect.custom}
              placeholder="Ratio, e.g. 51:48 or 16/9"
              aria-label="Custom crop aspect ratio"
              aria-invalid={aspect.custom.trim() !== '' && parseAspect(aspect.custom) === null}
              onBlur={(e) => {
                const field = e.currentTarget;
                if (field.value !== field.defaultValue) latest.current.onCustomAspectChange(field.value);
              }}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            />
          )}
        </>
      ))}
      {sections('retouch', [shapeUi, retouchShapes], (e) => {
        const ui = shapeUi;
        const setUi = (patch: Partial<ShapeUi>) => latest.current.onShapeUi(patch);
        // The overlay edits one instance at a time.
        const editing = isEditing(ui, 'retouch', e.id);
        const spots = e.values.spots;
        const sel = editing && ui.selected !== null && ui.selected < spots.length ? ui.selected : null;
        const spot = sel === null ? null : spots[sel]!;
        const shape = spot ? params.shapes?.[spot.shape] : undefined;
        const name = () => {
          const m = latest.current.params.modules.find((x) => x.id === e.id);
          return m ? instanceTitle(latest.current.params, m) : MODULE_TITLES.retouch;
        };
        /** Props for a slider bound to a field of the selected spot. */
        const bindSpot = (index: number, key: 'opacity' | 'radius') => {
          const with_ = (v: number) => updateSpot(latest.current.params, e.id, index, { [key]: v });
          return {
            value: spots[index]![key],
            defaultValue: defaultSpot[key],
            onChange: (v: number) => latest.current.onChange(with_(v)),
            onCommit: (v: number) => latest.current.onCommit(with_(v)),
          };
        };
        /** Props for a slider bound to the feather of the selected spot's shape. */
        const bindFeather = (id: string) => {
          const with_ = (v: number) => {
            const current = latest.current.params.shapes?.[id];
            return current && current.type !== 'brush'
              ? updateShape(latest.current.params, id, { ...current, feather: v })
              : latest.current.params;
          };
          return {
            value: shape && shape.type !== 'brush' ? shape.feather : 0,
            defaultValue: 0,
            onChange: (v: number) => latest.current.onChange(with_(v)),
            onCommit: (v: number) => latest.current.onCommit(with_(v), `${name()}: spot feather`),
          };
        };
        return (
          <>
            <ShapeToolBar ui={ui} target="retouch" id={e.id} kind="retouch" noun="spots" onUi={setUi} />
            <SelectRow label="New spots">
              {(id) => (
                <NativeSelect.Root size="xs" flex="1">
                  <NativeSelect.Field
                    id={id}
                    value={ui.mode}
                    onChange={(ev) => setUi({ mode: ev.target.value as SpotMode })}
                  >
                    {SPOT_MODES.map((mode) => (
                      <option key={mode} value={mode}>
                        {SPOT_MODE_LABELS[mode]}
                      </option>
                    ))}
                  </NativeSelect.Field>
                  <NativeSelect.Indicator />
                </NativeSelect.Root>
              )}
            </SelectRow>
            {ui.tool === 'brush' && editing && <BrushSettings ui={ui} onUi={setUi} />}
            {spots.length === 0 ? (
              <Text textStyle="2xs" color="fg.subtle">
                Pick a shape, then click or drag on the image to add a spot
              </Text>
            ) : (
              // Scrolls on its own: some images have many spots.
              <Stack
                gap="0"
                maxH="44"
                position="relative"
                overflowY="auto"
                borderWidth={spots.length > 7 ? '1px' : 0}
                borderRadius="l2"
              >
                {spots.map((s, i) => (
                  <HStack key={i} gap="0" ref={i === sel ? scrollIntoList : undefined}>
                    <Button
                      size="2xs"
                      flex="1"
                      justifyContent="flex-start"
                      variant={i === sel ? 'subtle' : 'ghost'}
                      colorPalette={i === sel ? 'orange' : 'gray'}
                      onClick={() =>
                        setUi({ editing: true, target: 'retouch', instance: e.id, kind: 'retouch', selected: i })
                      }
                    >
                      {i + 1}. {SPOT_MODE_LABELS[s.mode]}
                      <Text as="span" color="fg.subtle">
                        {params.shapes?.[s.shape] ? SHAPE_LABELS[params.shapes[s.shape]!.type] : ''}
                      </Text>
                    </Button>
                    <IconButton
                      size="2xs"
                      variant="ghost"
                      aria-label={`Delete spot ${i + 1}`}
                      onClick={() => {
                        commit((p) => removeSpot(p, e.id, i), `${name()}: spot removed`);
                        if (sel !== null && sel >= i) setUi({ selected: sel === i ? null : sel - 1 });
                      }}
                    >
                      <Trash2 />
                    </IconButton>
                  </HStack>
                ))}
              </Stack>
            )}
            {spot && sel !== null && (
              <Stack gap="1.5" key={sel}>
                <SelectRow label={`Spot ${sel + 1}`}>
                  {(id) => (
                    <NativeSelect.Root size="xs" flex="1">
                      <NativeSelect.Field
                        id={id}
                        value={spot.mode}
                        onChange={(ev) =>
                          commit(
                            (p) => updateSpot(p, e.id, sel, { mode: ev.target.value as SpotMode }),
                            `${name()}: spot mode`,
                          )
                        }
                      >
                        {SPOT_MODES.map((mode) => (
                          <option key={mode} value={mode}>
                            {SPOT_MODE_LABELS[mode]}
                          </option>
                        ))}
                      </NativeSelect.Field>
                      <NativeSelect.Indicator />
                    </NativeSelect.Root>
                  )}
                </SelectRow>
                <ParamSlider
                  label="Opacity"
                  min={0}
                  max={1}
                  step={0.01}
                  scale={100}
                  format={(v) => `${Math.round(v * 100)} %`}
                  {...bindSpot(sel, 'opacity')}
                />
                {shape && shape.type !== 'brush' && (
                  <ParamSlider
                    label="Feather"
                    min={0}
                    max={0.1}
                    step={0.001}
                    scale={100}
                    format={(v) => `${(v * 100).toFixed(1)} %`}
                    {...bindFeather(spot.shape)}
                  />
                )}
                {spot.mode === 'blur' && (
                  <ParamSlider
                    label="Blur radius"
                    min={0}
                    max={100}
                    step={0.5}
                    format={(v) => `${v.toFixed(1)} px`}
                    {...bindSpot(sel, 'radius')}
                  />
                )}
                {spot.mode === 'fill' && (
                  <HStack justify="space-between">
                    <Text textStyle="xs">Fill color</Text>
                    <input
                      type="color"
                      aria-label="Fill color"
                      value={rec2020ToHex(spot.color)}
                      onChange={(ev) =>
                        latest.current.onCommit(
                          updateSpot(latest.current.params, e.id, sel, { color: hexToRec2020(ev.target.value) }),
                        )
                      }
                    />
                  </HStack>
                )}
              </Stack>
            )}
          </>
        );
      })}
      <RenameDialog
        title={`Rename ${renamed ? MODULE_TITLES[renamed.kind].toLowerCase() : 'module'}`}
        hint="Leave empty to number it automatically."
        maxLength={60}
        open={!!renamed}
        name={renamed?.label ?? null}
        placeholder={renamed ? MODULE_TITLES[renamed.kind] : ''}
        onClose={onRenameClose}
        onRename={onRename}
      />
      {savingPreset && (
        <SavePresetDialog
          key={savingPreset.id}
          kind={savingPreset.kind}
          title={savingPreset.title}
          params={
            params.modules.find((m) => m.id === savingPreset.id)?.params ?? defaultModuleParams[savingPreset.kind]
          }
          mask={params.modules.find((m) => m.id === savingPreset.id)?.mask}
          shapes={params.shapes}
          existing={props.presets[savingPreset.kind] ?? NO_PRESETS}
          onClose={onSavePresetClose}
          onSave={onSavePreset}
        />
      )}
    </Box>
  );
});
