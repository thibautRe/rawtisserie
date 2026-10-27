import { Box, Button, ButtonGroup, HStack, Heading, IconButton, NativeSelect, Stack, Switch, Text } from '@chakra-ui/react';
import {
  BLEACH_LEVELS,
  type Bleach,
  type EditParams,
  type ModuleKind,
  type ModuleParams,
  defaultModuleParams,
  findModule,
  isModuleModified,
  resetModule,
  updateModule,
} from '@rawtisserie/pipeline';
import { Crop, FlipHorizontal2, RotateCcw, RotateCcwSquare, RotateCwSquare, WandSparkles } from 'lucide-react';
import { ParamSlider, fmt } from './ParamSlider.tsx';

interface Props {
  params: EditParams;
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

const BLEACH_LABELS: Record<Bleach, string> = {
  none: 'No bleach',
  low: 'Low bleach',
  medium: 'Medium bleach',
  high: 'High bleach',
  extra: 'Extra bleach',
};

export function ModulePanel({ params, onChange, onCommit, cropping, aspect, onAspectChange, onStartCrop, onAutoTuneFilmic, autoTuning }: Props) {
  // One instance per kind for now: the panel edits the first one.
  const values = <K extends ModuleKind>(kind: K): ModuleParams[K] => findModule(params, kind)?.params ?? defaultModuleParams[kind];
  const enabled = (kind: ModuleKind) => findModule(params, kind)?.enabled ?? false;
  // Editing a module switches it on, as in Ansel.
  const edit = <K extends ModuleKind>(kind: K, patch: Partial<ModuleParams[K]>) => updateModule(params, kind, { enabled: true, params: patch });
  const set = <K extends ModuleKind>(kind: K, patch: Partial<ModuleParams[K]>) => onCommit(edit(kind, patch));

  /** Header props for a module kind. */
  const module = (kind: ModuleKind) => ({
    enabled: enabled(kind),
    modified: isModuleModified(params, kind),
    onToggle: (on: boolean) => onCommit(updateModule(params, kind, { enabled: on })),
    onReset: () => onCommit(resetModule(params, kind)),
  });

  /** Props for a slider bound to a numeric parameter of a module kind. */
  function bind<K extends ModuleKind>(kind: K, key: keyof ModuleParams[K] & string) {
    const with_ = (v: number) => edit(kind, { [key]: v } as Partial<ModuleParams[K]>);
    return {
      value: values(kind)[key] as number,
      defaultValue: defaultModuleParams[kind][key] as number,
      onChange: (v: number) => onChange(with_(v)),
      onCommit: (v: number) => onCommit(with_(v)),
    };
  }

  const fm = values('filmic');
  const g = values('geometry');
  const cropped = g.crop.x !== 0 || g.crop.y !== 0 || g.crop.width !== 1 || g.crop.height !== 1;

  return (
    <Box px="3">
      <Module title="Exposure" {...module('exposure')}>
        <ParamSlider label="Exposure" min={-4} max={4} step={0.05} format={fmt.ev} {...bind('exposure', 'ev')} />
        <ParamSlider label="Black level" min={0} max={0.1} step={0.001} format={(v) => v.toFixed(3)} {...bind('exposure', 'black')} />
      </Module>

      <Module title="White balance" {...module('whiteBalance')}>
        <ParamSlider label="Warmth" min={-1} max={1} step={0.01} {...bind('whiteBalance', 'warmth')} />
        <ParamSlider label="Tint" min={-1} max={1} step={0.01} {...bind('whiteBalance', 'tint')} />
      </Module>

      <Module title="Color" {...module('color')}>
        <ParamSlider label="Saturation" min={-1} max={1} step={0.01} {...bind('color', 'saturation')} />
        <ParamSlider label="Vibrance" min={-1} max={1} step={0.01} {...bind('color', 'vibrance')} />
      </Module>

      <Module title="Shadows & highlights" {...module('shadowsHighlights')}>
        <ParamSlider label="Shadows" min={-1} max={1} step={0.01} {...bind('shadowsHighlights', 'shadows')} />
        <ParamSlider label="Highlights" min={-1} max={1} step={0.01} {...bind('shadowsHighlights', 'highlights')} />
      </Module>

      <Module title="Filmic" {...module('filmic')}>
        <ParamSlider label="White relative exposure" min={1} max={10} step={0.05} format={fmt.ev} {...bind('filmic', 'whiteExposure')} />
        <ParamSlider label="Black relative exposure" min={-14} max={-3} step={0.05} format={fmt.ev} {...bind('filmic', 'blackExposure')} />
        <HStack justify="space-between">
          <Button
            size="2xs"
            variant="outline"
            disabled={!enabled('filmic')}
            loading={autoTuning}
            onClick={onAutoTuneFilmic}
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
        <ParamSlider label="Contrast" min={0.5} max={3} step={0.01} format={fmt.fixed2} {...bind('filmic', 'contrast')} />
        <ParamSlider label="Latitude" min={0.1} max={50} step={0.1} format={(v) => `${v.toFixed(1)} %`} {...bind('filmic', 'latitude')} />
        <ParamSlider label="Shadows ↔ highlights balance" min={-50} max={50} step={0.5} format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} %`} {...bind('filmic', 'balance')} />
        <ParamSlider label="Hue preservation" min={-100} max={100} step={1} format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(0)} %`} {...bind('filmic', 'huePreservation')} />
        <NativeSelect.Root size="xs">
          <NativeSelect.Field
            value={fm.bleach}
            onChange={(e) => set('filmic', { bleach: e.target.value as Bleach })}
            aria-label="Colour science"
          >
            {BLEACH_LEVELS.map((b) => (
              <option key={b} value={b}>
                AgX, {BLEACH_LABELS[b].toLowerCase()}
              </option>
            ))}
          </NativeSelect.Field>
          <NativeSelect.Indicator />
        </NativeSelect.Root>
      </Module>

      <Module title="Sharpen" {...module('sharpen')}>
        <ParamSlider label="Amount" min={0} max={2} step={0.01} format={fmt.fixed2} {...bind('sharpen', 'amount')} />
        <ParamSlider label="Radius" min={0.3} max={5} step={0.05} format={(v) => `${v.toFixed(2)} px`} {...bind('sharpen', 'radius')} />
      </Module>

      <Module title="Blur" {...module('blur')}>
        <ParamSlider label="Radius" min={0} max={50} step={0.1} format={(v) => `${v.toFixed(1)} px`} {...bind('blur', 'radius')} />
      </Module>

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
          <Button size="xs" variant={cropping ? 'solid' : 'outline'} colorPalette={cropping ? 'orange' : 'gray'} onClick={onStartCrop}>
            <Crop /> {cropping ? 'Cropping…' : 'Crop'}
          </Button>
        </HStack>
        <ParamSlider label="Straighten" min={-45} max={45} step={0.1} format={(v) => `${v.toFixed(1)}°`} {...bind('geometry', 'angle')} />
        <HStack>
          <NativeSelect.Root size="xs" flex="1">
            <NativeSelect.Field value={aspect} onChange={(e) => onAspectChange(e.target.value)} aria-label="Crop aspect ratio">
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
    </Box>
  );
}
