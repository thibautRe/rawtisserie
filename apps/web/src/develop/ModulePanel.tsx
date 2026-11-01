import { Box, Button, ButtonGroup, HStack, Heading, IconButton, NativeSelect, Stack, Switch, Text } from '@chakra-ui/react';
import {
  BLEACH_LEVELS,
  type Bleach,
  type EditParams,
  EQUALIZER_CURVES,
  type EqualizerCurve,
  type ModuleKind,
  type ModuleParams,
  PRIMARIES,
  type Primary,
  type PrimaryName,
  defaultModuleParams,
  findModule,
  isModuleModified,
  resetModule,
  updateModule,
} from '@rawtisserie/pipeline';
import { ChevronDown, ChevronRight, Crop, FlipHorizontal2, RotateCcw, RotateCcwSquare, RotateCwSquare, WandSparkles } from 'lucide-react';
import { memo, useLayoutEffect, useRef, useState } from 'react';
import { CurveEditor } from './CurveEditor.tsx';
import { ParamSlider, fmt } from './ParamSlider.tsx';
import { tracks } from './slider.ts';

interface Props {
  params: EditParams;
  /** Source of the file's embedded lens correction data (`PhotoMetadata.lensCorrection`). */
  lensCorrection: string | null;
  onChange: (p: EditParams) => void;
  onCommit: (p: EditParams) => void;
  cropping: boolean;
  aspect: string;
  onAspectChange: (aspect: string) => void;
  onStartCrop: () => void;
  /** Measure filmic's white/black relative exposures on the image. */
  onAutoTuneFilmic: () => void;
  autoTuning: boolean;
}

export const ASPECTS = [
  { value: 'free', label: 'Free', ratio: null },
  { value: 'original', label: 'Original', ratio: 'original' },
  { value: '1:1', label: '1:1', ratio: 1 },
  { value: '3:2', label: '3:2', ratio: 3 / 2 },
  { value: '4:3', label: '4:3', ratio: 4 / 3 },
  { value: '5:4', label: '5:4', ratio: 5 / 4 },
  { value: '16:9', label: '16:9', ratio: 16 / 9 },
  { value: '2:3', label: '2:3', ratio: 2 / 3 },
  { value: '4:5', label: '4:5', ratio: 4 / 5 },
  { value: '9:16', label: '9:16', ratio: 9 / 16 },
] as const;

/**
 * One module kind. A kind without an instance shows its default parameters,
 * switched off; editing it (or switching it on) adds an instance.
 */
function Module({
  title,
  enabled,
  modified,
  onToggle,
  onReset,
  children,
}: {
  title: string;
  enabled: boolean;
  modified: boolean;
  onToggle: (enabled: boolean) => void;
  onReset: () => void;
  children: React.ReactNode;
}) {
  return (
    <Stack gap="1.5" pt="1.5" pb="2.5" borderBottomWidth="1px">
      <HStack justify="space-between" h="6">
        <Heading size="xs" fontSize="2xs" textTransform="uppercase" letterSpacing="wider" color={modified ? 'orange.fg' : 'fg.muted'}>
          {title}
        </Heading>
        <HStack gap="1">
          <Switch.Root size="xs" colorPalette="orange" checked={enabled} onCheckedChange={(e) => onToggle(e.checked)} aria-label={`Enable ${title}`}>
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
const PRIMARY_HUES: Record<PrimaryName, number> = { red: 0, yellow: 60, green: 120, cyan: 180, blue: 240, magenta: 300 };

const BLEACH_LABELS: Record<Bleach, string> = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  extra: 'Extra',
};

export function ModulePanel(props: Props) {
  const { params, lensCorrection, cropping, aspect, autoTuning } = props;
  // Handlers of a section that didn't re-render must still see the latest recipe and callbacks.
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  const [curve, setCurve] = useState<EqualizerCurve>('luma');
  const [primary, setPrimary] = useState<PrimaryName>('red');
  const [primariesAdvanced, setPrimariesAdvanced] = useState(false);

  // One instance per kind for now: the panel edits the first one.
  const values = <K extends ModuleKind>(kind: K, from = params): ModuleParams[K] => findModule(from, kind)?.params ?? defaultModuleParams[kind];
  const instances = (kind: ModuleKind) => params.modules.filter((m) => m.kind === kind);
  const enabled = (kind: ModuleKind) => findModule(params, kind)?.enabled ?? false;
  // Editing a module switches it on, as in Ansel.
  const edit = <K extends ModuleKind>(kind: K, patch: Partial<ModuleParams[K]>) => updateModule(latest.current.params, kind, { enabled: true, params: patch });
  const set = <K extends ModuleKind>(kind: K, patch: Partial<ModuleParams[K]>) => latest.current.onCommit(edit(kind, patch));

  /** Header props for a module kind. */
  const module = (kind: ModuleKind) => ({
    enabled: enabled(kind),
    modified: isModuleModified(params, kind),
    onToggle: (on: boolean) => latest.current.onCommit(updateModule(latest.current.params, kind, { enabled: on })),
    onReset: () => latest.current.onCommit(resetModule(latest.current.params, kind)),
  });

  /** Props for a slider bound to a numeric parameter of a module kind. */
  function bind<K extends ModuleKind>(kind: K, key: keyof ModuleParams[K] & string) {
    const with_ = (v: number) => edit(kind, { [key]: v } as Partial<ModuleParams[K]>);
    return {
      value: values(kind)[key] as number,
      defaultValue: defaultModuleParams[kind][key] as number,
      onChange: (v: number) => latest.current.onChange(with_(v)),
      onCommit: (v: number) => latest.current.onCommit(with_(v)),
    };
  }

  // Lens correction strengths: 0 … 200 % of the camera's correction.
  const percent = { min: 0, max: 2, step: 0.01, scale: 100, format: (v: number) => `${Math.round(v * 100)} %` };

  /** Props for a slider bound to one field of a colour primary. */
  function bindPrimary(name: PrimaryName, key: keyof Primary) {
    const with_ = (v: number) => edit('colorPrimaries', { [name]: { ...values('colorPrimaries', latest.current.params)[name], [key]: v } });
    return {
      value: values('colorPrimaries')[name][key],
      defaultValue: defaultModuleParams.colorPrimaries[name][key],
      onChange: (v: number) => latest.current.onChange(with_(v)),
      onCommit: (v: number) => latest.current.onCommit(with_(v)),
    };
  }

  /** Props for the slider that steps through filmic's bleach levels. */
  const bindBleach = () => {
    const with_ = (i: number) => edit('filmic', { bleach: BLEACH_LEVELS[i]! });
    return {
      value: BLEACH_LEVELS.indexOf(values('filmic').bleach),
      defaultValue: BLEACH_LEVELS.indexOf(defaultModuleParams.filmic.bleach),
      onChange: (i: number) => latest.current.onChange(with_(i)),
      onCommit: (i: number) => latest.current.onCommit(with_(i)),
    };
  };

  const eq = values('contrastEqualizer');
  const fm = values('filmic');
  const g = values('geometry');
  const cropped = g.crop.x !== 0 || g.crop.y !== 0 || g.crop.width !== 1 || g.crop.height !== 1;

  return (
    <Box px="3">
      <Section
        deps={[...instances('exposure')]}
        render={() => (
          <Module title="Exposure" {...module('exposure')}>
            <ParamSlider label="Exposure" min={-4} max={4} hardMin={-10} hardMax={10} step={0.05} format={fmt.ev} track={tracks.grey} {...bind('exposure', 'ev')} />
            <ParamSlider label="Black level" min={0} max={0.1} hardMax={1} step={0.001} format={(v) => v.toFixed(3)} {...bind('exposure', 'black')} />
          </Module>
        )}
      />

      <Section
        deps={[...instances('whiteBalance')]}
        render={() => (
          <Module title="White balance" {...module('whiteBalance')}>
            <ParamSlider label="Warmth" min={-1} max={1} step={0.01} track={tracks.warmth} {...bind('whiteBalance', 'warmth')} />
            <ParamSlider label="Tint" min={-1} max={1} step={0.01} track={tracks.tint} {...bind('whiteBalance', 'tint')} />
          </Module>
        )}
      />

      <Section
        deps={[...instances('color')]}
        render={() => (
          <Module title="Color" {...module('color')}>
            <ParamSlider label="Saturation" min={-1} max={1} step={0.01} {...bind('color', 'saturation')} />
            <ParamSlider label="Vibrance" min={-1} max={1} step={0.01} {...bind('color', 'vibrance')} />
          </Module>
        )}
      />

      <Section
        deps={[...instances('shadowsHighlights')]}
        render={() => (
          <Module title="Shadows & highlights" {...module('shadowsHighlights')}>
            <ParamSlider label="Shadows" min={-1} max={1} step={0.01} track={tracks.grey} {...bind('shadowsHighlights', 'shadows')} />
            <ParamSlider label="Highlights" min={-1} max={1} step={0.01} track={tracks.grey} {...bind('shadowsHighlights', 'highlights')} />
          </Module>
        )}
      />

      <Section
        deps={[...instances('colorPrimaries'), primary, primariesAdvanced]}
        render={() => (
          <Module title="Color primaries" {...module('colorPrimaries')}>
            <HStack gap="1" justify="space-between" role="radiogroup" aria-label="Primary">
              {PRIMARIES.map((name) => {
                const p = values('colorPrimaries')[name];
                const edited = p.hue !== 0 || p.saturation !== 0 || p.brightness !== 0;
                return (
                  <Box
                    key={name}
                    as="button"
                    role="radio"
                    aria-checked={primary === name}
                    aria-label={name}
                    title={name}
                    flex="1"
                    h="5"
                    borderRadius="sm"
                    bg={PRIMARY_SWATCHES[name]}
                    cursor="pointer"
                    position="relative"
                    outline={primary === name ? '2px solid' : 'none'}
                    outlineColor="fg"
                    outlineOffset="1px"
                    onClick={() => setPrimary(name)}
                  >
                    {edited && <Box position="absolute" top="1" right="1" boxSize="1.5" borderRadius="full" bg="white" boxShadow="xs" />}
                  </Box>
                );
              })}
            </HStack>
            <ParamSlider key={`${primary}-hue`} label="Hue" min={-180} max={180} step={1} track={tracks.hue(PRIMARY_HUES[primary])} format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(0)}°`} {...bindPrimary(primary, 'hue')} />
            <ParamSlider key={`${primary}-saturation`} label="Saturation" min={-100} max={100} step={1} track={tracks.saturation(PRIMARY_HUES[primary])} format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(0)} %`} {...bindPrimary(primary, 'saturation')} />
            <ParamSlider key={`${primary}-brightness`} label="Brightness" min={-0.25} max={0.25} hardMin={-1} hardMax={1} step={0.005} scale={100} track={tracks.brightness(PRIMARY_HUES[primary])} format={(v) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)} %`} {...bindPrimary(primary, 'brightness')} />
            <Button size="2xs" variant="ghost" alignSelf="start" px="0" onClick={() => setPrimariesAdvanced(!primariesAdvanced)}>
              {primariesAdvanced ? <ChevronDown /> : <ChevronRight />} Gamut and smoothing
            </Button>
            {primariesAdvanced && (
              <>
                <ParamSlider label="White level" min={-2} max={16} step={0.05} format={fmt.ev} {...bind('colorPrimaries', 'whiteLevel')} />
                <ParamSlider label="Gamut coverage" min={0} max={100} step={0.5} format={(v) => `${v.toFixed(1)} %`} {...bind('colorPrimaries', 'gamutCoverage')} />
                <ParamSlider label="Neutral protection" min={0} max={2} step={0.01} format={fmt.fixed2} {...bind('colorPrimaries', 'neutralProtection')} />
                <ParamSlider label="Brightness smoothing" min={1} max={100} step={0.5} format={(v) => `${v.toFixed(1)} %`} {...bind('colorPrimaries', 'brightnessSmoothing')} />
                <ParamSlider label="Saturation smoothing" min={0.01} max={2} step={0.01} format={fmt.fixed2} {...bind('colorPrimaries', 'saturationSmoothing')} />
                <ParamSlider label="Hue smoothing" min={0.01} max={6.28} step={0.01} scale={180 / Math.PI} format={(v) => `${((v * 180) / Math.PI).toFixed(0)}°`} {...bind('colorPrimaries', 'hueSmoothing')} />
              </>
            )}
          </Module>
        )}
      />

      <Section
        deps={[...instances('contrastEqualizer'), curve]}
        render={() => (
          <Module title="Contrast equalizer" {...module('contrastEqualizer')}>
            <NativeSelect.Root size="xs">
              <NativeSelect.Field value={curve} onChange={(e) => setCurve(e.target.value as EqualizerCurve)} aria-label="Curve">
                {EQUALIZER_CURVES.map((c) => (
                  <option key={c} value={c}>
                    {EQUALIZER_LABELS[c]}
                  </option>
                ))}
              </NativeSelect.Field>
              <NativeSelect.Indicator />
            </NativeSelect.Root>
            <CurveEditor
              label={EQUALIZER_LABELS[curve]}
              values={eq[curve]}
              defaults={defaultModuleParams.contrastEqualizer[curve]}
              neutral={defaultModuleParams.contrastEqualizer[curve][0]!}
              left="coarse"
              right="fine"
              onChange={(v) => latest.current.onChange(edit('contrastEqualizer', { [curve]: v }))}
              onCommit={(v) => latest.current.onCommit(edit('contrastEqualizer', { [curve]: v }))}
            />
            <ParamSlider label="Mix" min={-2} max={2} step={0.01} format={fmt.fixed2} {...bind('contrastEqualizer', 'mix')} />
          </Module>
        )}
      />

      <Section
        deps={[...instances('filmic'), autoTuning]}
        render={() => (
          <Module title="Filmic" {...module('filmic')}>
            <ParamSlider label="White relative exposure" min={1} max={10} hardMin={0.1} hardMax={16} step={0.05} format={fmt.ev} track={tracks.grey} {...bind('filmic', 'whiteExposure')} />
            <ParamSlider label="Black relative exposure" min={-14} max={-3} hardMin={-16} hardMax={-0.1} step={0.05} format={fmt.ev} track={tracks.grey} {...bind('filmic', 'blackExposure')} />
            <HStack justify="space-between">
              <Button
                size="2xs"
                variant="outline"
                disabled={!enabled('filmic')}
                loading={autoTuning}
                onClick={() => latest.current.onAutoTuneFilmic()}
                title="Set white and black relative exposure from the image (like Ansel's auto-tune)"
              >
                <WandSparkles /> Auto-tune
              </Button>
              <Text textStyle="2xs" color="fg.subtle">
                dynamic range {(fm.whiteExposure - fm.blackExposure).toFixed(2)} EV
              </Text>
            </HStack>
            <ParamSlider
              label="Dynamic range scaling (auto-tune)"
              min={-50}
              max={200}
              step={1}
              format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(0)} %`}
              {...bind('filmic', 'dynamicRangeScaling')}
            />
            <ParamSlider label="Contrast" min={0.5} max={3} hardMin={0} hardMax={5} step={0.01} format={fmt.fixed2} {...bind('filmic', 'contrast')} />
            <ParamSlider label="Toe" min={0} max={100} step={0.5} format={(v) => `${v.toFixed(1)} %`} {...bind('filmic', 'toe')} />
            <ParamSlider label="Shoulder" min={0} max={100} step={0.5} format={(v) => `${v.toFixed(1)} %`} {...bind('filmic', 'shoulder')} />
            <ParamSlider label="Hue preservation" min={-100} max={100} step={1} format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(0)} %`} {...bind('filmic', 'huePreservation')} />
            <ParamSlider label="AgX bleach" min={0} max={BLEACH_LEVELS.length - 1} step={1} detents format={(i) => BLEACH_LABELS[BLEACH_LEVELS[i]!]} {...bindBleach()} />
          </Module>
        )}
      />

      <Section
        deps={[...instances('sharpen')]}
        render={() => (
          <Module title="Sharpen" {...module('sharpen')}>
            <ParamSlider label="Amount" min={0} max={2} hardMax={5} step={0.01} format={fmt.fixed2} {...bind('sharpen', 'amount')} />
            <ParamSlider label="Radius" min={0.3} max={5} step={0.05} format={(v) => `${v.toFixed(2)} px`} {...bind('sharpen', 'radius')} />
          </Module>
        )}
      />

      <Section
        deps={[...instances('blur')]}
        render={() => (
          <Module title="Blur" {...module('blur')}>
            <ParamSlider label="Radius" min={0} max={50} step={0.1} format={(v) => `${v.toFixed(1)} px`} {...bind('blur', 'radius')} />
          </Module>
        )}
      />

      <Section
        deps={[...instances('lens'), lensCorrection]}
        render={() => (
          <Module title="Lens correction" {...module('lens')}>
            {!lensCorrection && (
              <Text textStyle="2xs" color="fg.subtle">
                This file has no lens correction data
              </Text>
            )}
            <ParamSlider label="Distortion" disabled={!lensCorrection} {...percent} {...bind('lens', 'distortion')} />
            <ParamSlider label="Chromatic aberration" disabled={!lensCorrection} {...percent} {...bind('lens', 'tca')} />
            <ParamSlider label="Vignetting" disabled={!lensCorrection} {...percent} {...bind('lens', 'vignetting')} />
          </Module>
        )}
      />

      <Section
        deps={[...instances('geometry'), cropping, aspect]}
        render={() => (
          <Module title="Geometry" {...module('geometry')}>
            <HStack justify="space-between">
              <ButtonGroup size="xs" variant="outline" attached>
                <IconButton aria-label="Rotate left" onClick={() => set('geometry', { rotation: (g.rotation + 3) % 4 })}>
                  <RotateCcwSquare />
                </IconButton>
                <IconButton aria-label="Rotate right" onClick={() => set('geometry', { rotation: (g.rotation + 1) % 4 })}>
                  <RotateCwSquare />
                </IconButton>
                <IconButton
                  aria-label="Flip horizontally"
                  variant={g.flipHorizontal ? 'solid' : 'outline'}
                  onClick={() => set('geometry', { flipHorizontal: !g.flipHorizontal })}
                >
                  <FlipHorizontal2 />
                </IconButton>
              </ButtonGroup>
              <Button size="xs" variant={cropping ? 'solid' : 'outline'} colorPalette={cropping ? 'orange' : 'gray'} onClick={() => latest.current.onStartCrop()}>
                <Crop /> {cropping ? 'Cropping…' : 'Crop'}
              </Button>
            </HStack>
            <ParamSlider label="Straighten" min={-45} max={45} step={0.1} format={(v) => `${v.toFixed(1)}°`} {...bind('geometry', 'angle')} />
            <HStack>
              <NativeSelect.Root size="xs" flex="1">
                <NativeSelect.Field value={aspect} onChange={(e) => latest.current.onAspectChange(e.target.value)} aria-label="Crop aspect ratio">
                  {ASPECTS.map((a) => (
                    <option key={a.value} value={a.value}>
                      Aspect: {a.label}
                    </option>
                  ))}
                </NativeSelect.Field>
                <NativeSelect.Indicator />
              </NativeSelect.Root>
              <Button size="xs" variant="ghost" disabled={!cropped} onClick={() => set('geometry', { crop: { ...defaultModuleParams.geometry.crop } })}>
                Uncrop
              </Button>
            </HStack>
          </Module>
        )}
      />
    </Box>
  );
}
