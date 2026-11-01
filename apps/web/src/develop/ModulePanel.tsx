import { Box, Button, ButtonGroup, HStack, Heading, IconButton, Menu, NativeSelect, Portal, Stack, Switch, Text } from '@chakra-ui/react';
import {
  BLEACH_LEVELS,
  type Bleach,
  type EditParams,
  EQUALIZER_CURVES,
  type EqualizerCurve,
  type ModuleInstance,
  type ModuleKind,
  type ModuleParams,
  PRIMARIES,
  type Primary,
  type PrimaryName,
  SINGLE_INSTANCE_KINDS,
  addInstance,
  defaultModuleParams,
  instanceDefaults,
  isInstanceModified,
  moveInstance,
  removeInstance,
  resetInstance,
  updateInstance,
} from '@rawtisserie/pipeline';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Crop, EllipsisVertical, FlipHorizontal2, Pencil, Plus, RotateCcw, RotateCcwSquare, RotateCwSquare, Trash2, WandSparkles } from 'lucide-react';
import { memo, useLayoutEffect, useRef, useState } from 'react';
import { RenameDialog } from '../components/RenameDialog.tsx';
import { MODULE_TITLES, instanceTitle } from './changes.ts';
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

type InstanceAction = 'new' | 'rename' | 'up' | 'down' | 'delete';

/**
 * A module header's menu. Its handler goes through `latest`, so it's left out when
 * comparing props: this way dragging a slider doesn't restyle the menu.
 */
const InstanceMenu = memo(
  ({ title, position, count, disabled, onAction }: { title: string; position: number; count: number; disabled: boolean; onAction: (action: InstanceAction) => void }) => (
    <Menu.Root lazyMount unmountOnExit onSelect={(d) => onAction(d.value as InstanceAction)}>
      <Menu.Trigger asChild>
        <IconButton aria-label={`${title} instances`} title="Module instances" size="2xs" variant="ghost" disabled={disabled}>
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
            <Menu.Item value="delete" disabled={count <= 1} color="fg.error" _highlighted={{ bg: 'bg.error', color: 'fg.error' }}>
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
 * One module instance. A kind without an instance shows its default parameters,
 * switched off; editing it (or switching it on) adds an instance.
 */
function Module({
  title,
  enabled,
  modified,
  menu,
  onToggle,
  onReset,
  children,
}: {
  title: string;
  enabled: boolean;
  modified: boolean;
  /** Absent for single-instance kinds. */
  menu?: React.ReactNode;
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
          {menu}
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

/** What an instance's section shows, which isn't part of the recipe. */
interface InstanceView {
  primary: PrimaryName;
  primariesAdvanced: boolean;
  curve: EqualizerCurve;
}

const DEFAULT_VIEW: InstanceView = { primary: 'red', primariesAdvanced: false, curve: 'luma' };

const isCropped = (c: ModuleParams['geometry']['crop']) => c.x !== 0 || c.y !== 0 || c.width !== 1 || c.height !== 1;

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
  // What each instance shows, by id.
  const [views, setViews] = useState<Record<string, InstanceView>>({});

  const [renaming, setRenaming] = useState<string | null>(null);
  const renamed = params.modules.find((m) => m.id === renaming);

  const commit = (change: (p: EditParams) => EditParams) => latest.current.onCommit(change(latest.current.params));

  /** Lets the content of one instance read and edit it. Without an instance, this is its future one. */
  function editor<K extends ModuleKind>(kind: K, m: ModuleInstance<K> | undefined, position: number) {
    const defaults = instanceDefaults(kind, position);
    const id = m?.id ?? kind;
    const values = m?.params ?? defaultModuleParams[kind];
    // Editing a module switches it on, as in Ansel.
    const edit = (patch: Partial<ModuleParams[K]>) => updateInstance(latest.current.params, kind, id, { enabled: true, params: patch });
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
    const current = () => (latest.current.params.modules.find((x) => x.id === id) as ModuleInstance<K> | undefined)?.params ?? defaultModuleParams[kind];
    const setView = (patch: Partial<InstanceView>) => setViews((v) => ({ ...v, [id]: { ...DEFAULT_VIEW, ...v[id], ...patch } }));
    return { view: views[id] ?? DEFAULT_VIEW, setView, values, current, enabled: m?.enabled ?? false, edit, set: (patch: Partial<ModuleParams[K]>) => latest.current.onCommit(edit(patch)), bind };
  }

  /**
   * A section per instance of a kind (or one for the kind, without any). Sections are
   * keyed by instance id and an empty kind's first instance takes the kind as its id,
   * so a slider dragged there stays mounted, bound to that id.
   */
  function sections<K extends ModuleKind>(kind: K, deps: readonly unknown[], content: (e: ReturnType<typeof editor<K>>) => React.ReactNode) {
    const list = params.modules.filter((m) => m.kind === kind) as ModuleInstance<K>[];
    const count = list.length;
    return (count ? list : [undefined]).map((m, position) => {
      const id = m?.id ?? kind;
      const title = m ? instanceTitle(params, m) : MODULE_TITLES[kind];
      return (
        <Section
          key={id}
          deps={[m, position, count, title, views[id], ...deps]}
          render={() => (
            <Module
              title={title}
              enabled={m?.enabled ?? false}
              modified={isInstanceModified(params, kind, id)}
              onToggle={(on) => commit((p) => updateInstance(p, kind, id, { enabled: on }))}
              onReset={() => commit((p) => resetInstance(p, kind, id))}
              menu={
                !SINGLE_INSTANCE_KINDS.includes(kind) && (
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
                )
              }
            >
              {content(editor(kind, m, position))}
            </Module>
          )}
        />
      );
    });
  }

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

  return (
    <Box px="3">
      {sections('exposure', [], (e) => (
        <>
          <ParamSlider label="Exposure" min={-4} max={4} hardMin={-10} hardMax={10} step={0.05} format={fmt.ev} track={tracks.grey} {...e.bind('ev')} />
          <ParamSlider label="Black level" min={0} max={0.1} hardMax={1} step={0.001} format={(v) => v.toFixed(3)} {...e.bind('black')} />
        </>
      ))}

      {sections('whiteBalance', [], (e) => (
        <>
          <ParamSlider label="Warmth" min={-1} max={1} step={0.01} track={tracks.warmth} {...e.bind('warmth')} />
          <ParamSlider label="Tint" min={-1} max={1} step={0.01} track={tracks.tint} {...e.bind('tint')} />
        </>
      ))}

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
                  {edited && <Box position="absolute" top="1" right="1" boxSize="1.5" borderRadius="full" bg="white" boxShadow="xs" />}
                </Box>
              );
            })}
          </HStack>
          <ParamSlider key={`${e.view.primary}-hue`} label="Hue" min={-180} max={180} step={1} track={tracks.hue(PRIMARY_HUES[e.view.primary])} format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(0)}°`} {...bindPrimary(e, e.view.primary, 'hue')} />
          <ParamSlider key={`${e.view.primary}-saturation`} label="Saturation" min={-100} max={100} step={1} track={tracks.saturation(PRIMARY_HUES[e.view.primary])} format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(0)} %`} {...bindPrimary(e, e.view.primary, 'saturation')} />
          <ParamSlider key={`${e.view.primary}-brightness`} label="Brightness" min={-0.25} max={0.25} hardMin={-1} hardMax={1} step={0.005} scale={100} track={tracks.brightness(PRIMARY_HUES[e.view.primary])} format={(v) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)} %`} {...bindPrimary(e, e.view.primary, 'brightness')} />
          <Button size="2xs" variant="ghost" alignSelf="start" px="0" onClick={() => e.setView({ primariesAdvanced: !e.view.primariesAdvanced })}>
            {e.view.primariesAdvanced ? <ChevronDown /> : <ChevronRight />} Gamut and smoothing
          </Button>
          {e.view.primariesAdvanced && (
            <>
              <ParamSlider label="White level" min={-2} max={16} step={0.05} format={fmt.ev} {...e.bind('whiteLevel')} />
              <ParamSlider label="Gamut coverage" min={0} max={100} step={0.5} format={(v) => `${v.toFixed(1)} %`} {...e.bind('gamutCoverage')} />
              <ParamSlider label="Neutral protection" min={0} max={2} step={0.01} format={fmt.fixed2} {...e.bind('neutralProtection')} />
              <ParamSlider label="Brightness smoothing" min={1} max={100} step={0.5} format={(v) => `${v.toFixed(1)} %`} {...e.bind('brightnessSmoothing')} />
              <ParamSlider label="Saturation smoothing" min={0.01} max={2} step={0.01} format={fmt.fixed2} {...e.bind('saturationSmoothing')} />
              <ParamSlider label="Hue smoothing" min={0.01} max={6.28} step={0.01} scale={180 / Math.PI} format={(v) => `${((v * 180) / Math.PI).toFixed(0)}°`} {...e.bind('hueSmoothing')} />
            </>
          )}
        </>
      ))}

      {sections('contrastEqualizer', [], (e) => (
        <>
          <NativeSelect.Root size="xs">
            <NativeSelect.Field value={e.view.curve} onChange={(ev) => e.setView({ curve: ev.target.value as EqualizerCurve })} aria-label="Curve">
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

      {sections('filmic', [autoTuning], (e) => (
        <>
          <ParamSlider label="White relative exposure" min={1} max={10} hardMin={0.1} hardMax={16} step={0.05} format={fmt.ev} track={tracks.grey} {...e.bind('whiteExposure')} />
          <ParamSlider label="Black relative exposure" min={-14} max={-3} hardMin={-16} hardMax={-0.1} step={0.05} format={fmt.ev} track={tracks.grey} {...e.bind('blackExposure')} />
          <HStack justify="space-between">
            <Button
              size="2xs"
              variant="outline"
              disabled={!e.enabled}
              loading={autoTuning}
              onClick={() => latest.current.onAutoTuneFilmic()}
              title="Set white and black relative exposure from the image (like Ansel's auto-tune)"
            >
              <WandSparkles /> Auto-tune
            </Button>
            <Text textStyle="2xs" color="fg.subtle">
              dynamic range {(e.values.whiteExposure - e.values.blackExposure).toFixed(2)} EV
            </Text>
          </HStack>
          <ParamSlider
            label="Dynamic range scaling (auto-tune)"
            min={-50}
            max={200}
            step={1}
            format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(0)} %`}
            {...e.bind('dynamicRangeScaling')}
          />
          <ParamSlider label="Contrast" min={0.5} max={3} hardMin={0} hardMax={5} step={0.01} format={fmt.fixed2} {...e.bind('contrast')} />
          <ParamSlider label="Toe" min={0} max={100} step={0.5} format={(v) => `${v.toFixed(1)} %`} {...e.bind('toe')} />
          <ParamSlider label="Shoulder" min={0} max={100} step={0.5} format={(v) => `${v.toFixed(1)} %`} {...e.bind('shoulder')} />
          <ParamSlider label="Hue preservation" min={-100} max={100} step={1} format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(0)} %`} {...e.bind('huePreservation')} />
          <ParamSlider label="AgX bleach" min={0} max={BLEACH_LEVELS.length - 1} step={1} detents format={(i) => BLEACH_LABELS[BLEACH_LEVELS[i]!]} {...bindBleach(e)} />
        </>
      ))}

      {sections('sharpen', [], (e) => (
        <>
          <ParamSlider label="Amount" min={0} max={2} hardMax={5} step={0.01} format={fmt.fixed2} {...e.bind('amount')} />
          <ParamSlider label="Radius" min={0.3} max={5} step={0.05} format={(v) => `${v.toFixed(2)} px`} {...e.bind('radius')} />
        </>
      ))}

      {sections('blur', [], (e) => (
        <>
          <ParamSlider label="Radius" min={0} max={50} step={0.1} format={(v) => `${v.toFixed(1)} px`} {...e.bind('radius')} />
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

      {sections('geometry', [cropping, aspect], (e) => (
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
            <Button size="xs" variant={cropping ? 'solid' : 'outline'} colorPalette={cropping ? 'orange' : 'gray'} onClick={() => latest.current.onStartCrop()}>
              <Crop /> {cropping ? 'Cropping…' : 'Crop'}
            </Button>
          </HStack>
          <ParamSlider label="Straighten" min={-45} max={45} step={0.1} format={(v) => `${v.toFixed(1)}°`} {...e.bind('angle')} />
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
            <Button size="xs" variant="ghost" disabled={!isCropped(e.values.crop)} onClick={() => e.set({ crop: { ...defaultModuleParams.geometry.crop } })}>
              Uncrop
            </Button>
          </HStack>
        </>
      ))}
      <RenameDialog
        title={`Rename ${renamed ? MODULE_TITLES[renamed.kind].toLowerCase() : 'module'}`}
        hint="Leave empty to number it automatically."
        maxLength={60}
        open={!!renamed}
        name={renamed?.label ?? null}
        placeholder={renamed ? MODULE_TITLES[renamed.kind] : ''}
        onClose={() => setRenaming(null)}
        onRename={(label) => renamed && commit((p) => updateInstance(p, renamed.kind, renamed.id, { label }))}
      />
    </Box>
  );
}
