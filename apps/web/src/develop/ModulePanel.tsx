import { Box, Button, ButtonGroup, HStack, Heading, IconButton, NativeSelect, Stack, Switch } from '@chakra-ui/react';
import { type EditParams, defaultEditParams } from '@rawtisserie/pipeline';
import { Crop, FlipHorizontal2, RotateCcw, RotateCcwSquare, RotateCwSquare } from 'lucide-react';
import { ParamSlider, fmt } from './ParamSlider.tsx';

type Section = Exclude<keyof EditParams, 'version'>;

interface Props {
  params: EditParams;
  onChange: (p: EditParams) => void;
  onCommit: (p: EditParams) => void;
  cropping: boolean;
  aspect: string;
  onAspectChange: (aspect: string) => void;
  onStartCrop: () => void;
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

function Module({ title, modified, onReset, children }: { title: string; modified: boolean; onReset: () => void; children: React.ReactNode }) {
  return (
    <Stack gap="3" py="3" borderBottomWidth="1px">
      <HStack justify="space-between">
        <Heading size="xs" textTransform="uppercase" letterSpacing="wider" color={modified ? 'orange.fg' : 'fg.muted'}>
          {title}
        </Heading>
        <IconButton aria-label={`Reset ${title}`} size="2xs" variant="ghost" disabled={!modified} onClick={onReset}>
          <RotateCcw />
        </IconButton>
      </HStack>
      {children}
    </Stack>
  );
}

export function ModulePanel({ params, onChange, onCommit, cropping, aspect, onAspectChange, onStartCrop }: Props) {
  const modified = (s: Section) => JSON.stringify(params[s]) !== JSON.stringify(defaultEditParams[s]);
  const resetSection = (s: Section) => onCommit({ ...params, [s]: structuredClone(defaultEditParams[s]) });

  /** Props for a slider bound to `params[section][key]`. */
  function bind<S extends Section>(section: S, key: keyof EditParams[S] & string) {
    const with_ = (v: number) => ({ ...params, [section]: { ...params[section], [key]: v } });
    return {
      value: params[section][key] as number,
      defaultValue: defaultEditParams[section][key] as number,
      onChange: (v: number) => onChange(with_(v)),
      onCommit: (v: number) => onCommit(with_(v)),
    };
  }

  const g = params.geometry;
  const setGeometry = (patch: Partial<EditParams['geometry']>) => onCommit({ ...params, geometry: { ...g, ...patch } });
  const cropped = g.crop.x !== 0 || g.crop.y !== 0 || g.crop.width !== 1 || g.crop.height !== 1;

  return (
    <Box px="4">
      <Module title="Exposure" modified={modified('exposure')} onReset={() => resetSection('exposure')}>
        <ParamSlider label="Exposure" min={-4} max={4} step={0.05} format={fmt.ev} {...bind('exposure', 'ev')} />
        <ParamSlider label="Black level" min={0} max={0.1} step={0.001} format={(v) => v.toFixed(3)} {...bind('exposure', 'black')} />
      </Module>

      <Module title="White balance" modified={modified('whiteBalance')} onReset={() => resetSection('whiteBalance')}>
        <ParamSlider label="Warmth" min={-1} max={1} step={0.01} {...bind('whiteBalance', 'warmth')} />
        <ParamSlider label="Tint" min={-1} max={1} step={0.01} {...bind('whiteBalance', 'tint')} />
      </Module>

      <Module title="Tone mapping" modified={modified('toneMap')} onReset={() => resetSection('toneMap')}>
        <Switch.Root
          size="sm"
          colorPalette="orange"
          checked={params.toneMap.enabled}
          onCheckedChange={(e) => onCommit({ ...params, toneMap: { ...params.toneMap, enabled: e.checked } })}
        >
          <Switch.HiddenInput />
          <Switch.Control />
          <Switch.Label textStyle="xs">Sigmoid tone mapper</Switch.Label>
        </Switch.Root>
        <ParamSlider label="Contrast" min={0.5} max={3} step={0.01} format={fmt.fixed2} disabled={!params.toneMap.enabled} {...bind('toneMap', 'contrast')} />
        <ParamSlider label="Shadows" min={-1} max={1} step={0.01} {...bind('toneMap', 'shadows')} />
        <ParamSlider label="Highlights" min={-1} max={1} step={0.01} {...bind('toneMap', 'highlights')} />
      </Module>

      <Module title="Color" modified={modified('color')} onReset={() => resetSection('color')}>
        <ParamSlider label="Saturation" min={-1} max={1} step={0.01} {...bind('color', 'saturation')} />
        <ParamSlider label="Vibrance" min={-1} max={1} step={0.01} {...bind('color', 'vibrance')} />
      </Module>

      <Module title="Sharpen" modified={modified('sharpen')} onReset={() => resetSection('sharpen')}>
        <ParamSlider label="Amount" min={0} max={2} step={0.01} format={fmt.fixed2} {...bind('sharpen', 'amount')} />
        <ParamSlider label="Radius" min={0.3} max={5} step={0.05} format={(v) => `${v.toFixed(2)} px`} {...bind('sharpen', 'radius')} />
      </Module>

      <Module title="Blur" modified={modified('blur')} onReset={() => resetSection('blur')}>
        <ParamSlider label="Radius" min={0} max={50} step={0.1} format={(v) => `${v.toFixed(1)} px`} {...bind('blur', 'radius')} />
      </Module>

      <Module title="Geometry" modified={modified('geometry')} onReset={() => resetSection('geometry')}>
        <HStack justify="space-between">
          <ButtonGroup size="xs" variant="outline" attached>
            <IconButton aria-label="Rotate left" onClick={() => setGeometry({ rotation: (g.rotation + 3) % 4 })}>
              <RotateCcwSquare />
            </IconButton>
            <IconButton aria-label="Rotate right" onClick={() => setGeometry({ rotation: (g.rotation + 1) % 4 })}>
              <RotateCwSquare />
            </IconButton>
            <IconButton
              aria-label="Flip horizontally"
              variant={g.flipHorizontal ? 'solid' : 'outline'}
              onClick={() => setGeometry({ flipHorizontal: !g.flipHorizontal })}
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
          <Button size="xs" variant="ghost" disabled={!cropped} onClick={() => setGeometry({ crop: { ...defaultEditParams.geometry.crop } })}>
            Uncrop
          </Button>
        </HStack>
      </Module>
    </Box>
  );
}
