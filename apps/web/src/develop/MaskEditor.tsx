import { Box, Button, HStack, IconButton, NativeSelect, Stack, Switch, Tabs, Text } from '@chakra-ui/react';
import {
  type BlendMode,
  type EditParams,
  FULCRUM_BLEND_MODES,
  type Mask,
  type MaskRange,
  type ModuleKind,
  SHAPE_OPS,
  type ShapeOp,
  type ShapeType,
  defaultMask,
  isDisplayReferred,
  removeMaskShape,
  updateMask,
} from '@rawtisserie/pipeline';
import { Eye, ScanEye, Trash2 } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import {
  type Handle,
  RANGES,
  RANGE_KEYS,
  type RangeConfig,
  type RangeKey,
  moveHandle,
  rangePolygons,
  growSpan,
  shiftRange,
  trackSpan,
} from './masks.ts';
import { ParamSlider } from './ParamSlider.tsx';
import type { MaskView } from './protocol.ts';
import { type ShapeUi, isEditing } from './retouch.ts';
import { BrushSettings, ShapeToolBar } from './ShapeTools.tsx';

const OP_LABELS: Record<ShapeOp, string> = {
  union: 'Add',
  intersection: 'Intersect',
  difference: 'Subtract',
  exclusion: 'Exclude',
};
const OP_TITLES: Record<ShapeOp, string> = {
  union: 'Add to the shapes before',
  intersection: 'Keep only where it overlaps the shapes before',
  difference: 'Take away from the shapes before',
  exclusion: 'Where it or the shapes before are, not both',
};
/** Blend modes, grouped as the menu shows them. */
const BLEND_GROUPS: { label: string; modes: BlendMode[] }[] = [
  { label: 'Normal', modes: ['normal'] },
  { label: 'Lighten and darken', modes: ['lighten', 'darken', 'screen', 'multiply', 'divide'] },
  { label: 'Contrast', modes: ['overlay', 'softLight', 'hardLight'] },
  { label: 'Arithmetic', modes: ['addition', 'subtraction', 'difference'] },
  { label: 'Means', modes: ['average', 'geometricMean', 'harmonicMean'] },
  { label: 'Components', modes: ['chroma', 'luminance', 'red', 'green', 'blue'] },
];
const BLEND_LABELS: Record<BlendMode, string> = {
  normal: 'Normal',
  lighten: 'Lighten',
  darken: 'Darken',
  multiply: 'Multiply',
  divide: 'Divide',
  addition: 'Addition',
  subtraction: 'Subtraction',
  difference: 'Difference',
  average: 'Average',
  geometricMean: 'Geometric mean',
  harmonicMean: 'Harmonic mean',
  screen: 'Screen',
  overlay: 'Overlay',
  softLight: 'Soft light',
  hardLight: 'Hard light',
  chroma: 'Chroma',
  luminance: 'Luminance',
  red: 'Red',
  green: 'Green',
  blue: 'Blue',
};
/** What each mode gives, with `a` the module's input and `b` its output. */
const BLEND_TITLES: Record<BlendMode, string> = {
  normal: 'The module’s output',
  lighten: 'The brighter of input and output, per channel',
  darken: 'The darker of input and output, per channel',
  multiply: 'Input × output, divided by the fulcrum (white, after filmic): darkens where the output is below it',
  divide: 'Input ÷ output, times the fulcrum (white, after filmic)',
  addition: 'Input + output',
  subtraction: 'Input − output, down to black',
  difference: 'How far the output is from the input',
  average: 'Halfway between input and output',
  geometricMean: '√(input × output): halfway in exposure',
  harmonicMean: '2·input·output ÷ (input + output): leans to the darker',
  screen: 'Brightens by the output, never darkens',
  overlay: 'Contrast steered by the input: darker below the fulcrum, brighter above',
  softLight: 'Gentle contrast steered by the output: darker below the fulcrum, brighter above',
  hardLight: 'Strong contrast steered by the output: darker below the fulcrum, brighter above',
  chroma: 'The output’s colour at the input’s brightness',
  luminance: 'The output’s brightness with the input’s colour',
  red: 'Only the output’s red channel',
  green: 'Only the output’s green channel',
  blue: 'Only the output’s blue channel',
};
const signedEv = (v: number) =>
  `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v)
    .toFixed(2)
    .replace(/\.?0+$/, '')} EV`;

const SHAPE_LABELS: Record<ShapeType, string> = {
  ellipse: 'Ellipse',
  gradient: 'Gradient',
  path: 'Path',
  brush: 'Brush',
};

const TRACK_H = 14;

/**
 * A feathered range `[a, b, c, d]` on a track: drag a handle (`a` and `d` at the
 * bottom, `b` and `c` at the top) or the shape between them to move it all. Held past
 * an end of the track (which works at the edge of the screen too: the track stops short
 * of it), the track widens under the pointer, up to the hard limits, so the handle keeps
 * going; on release the track fits the range again. Off (null), the range selects
 * everything. Handles take arrow keys (Shift: ×10).
 */
function RangeSlider({
  config: c,
  value,
  restore,
  view,
  onView,
  onChange,
  onCommit,
}: {
  config: RangeConfig;
  value: MaskRange | null;
  /** What switching it on selects, if not the default: as it was when switched off. */
  restore: MaskRange | undefined;
  /** What the overlay shows of this range: where it applies, its values, or neither. */
  view: 'selection' | 'values' | null;
  onView: (view: 'selection' | 'values' | null) => void;
  onChange: (r: MaskRange | null) => void;
  onCommit: (r: MaskRange | null) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const drag = useRef<{
    handle: Handle | 'all';
    from: MaskRange;
    start: number;
    last: MaskRange;
    span: [number, number];
    clientX: number;
    /** The animation frame widening the track, while the pointer is past one of its ends. */
    frame: number | null;
    time: number;
  } | null>(null);
  const range = value ?? c.initial;
  const span = drag.current?.span ?? trackSpan(value, c);
  const at = (clientX: number, [lo, hi] = span) => {
    const r = track.current!.getBoundingClientRect();
    return lo + ((clientX - r.left) / r.width) * (hi - lo);
  };
  const x = (v: number) => `${((v - span[0]) / (span[1] - span[0])) * 100}%`;
  const onDown = (handle: Handle | 'all') => (e: React.PointerEvent) => {
    if (!value || e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = {
      handle,
      from: value,
      start: at(e.clientX),
      last: value,
      span,
      clientX: e.clientX,
      frame: null,
      time: 0,
    };
  };
  /** Where the pointer is past the track: -1 left of it, 1 right of it, 0 over it. */
  const past = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return clientX > r.right ? 1 : clientX < r.left ? -1 : 0;
  };
  const apply = (d: NonNullable<typeof drag.current>) => {
    const v = at(d.clientX, d.span);
    const next = d.handle === 'all' ? shiftRange(d.from, v - d.start, c) : moveHandle(d.from, d.handle, v, c);
    if (next.some((x, i) => x !== d.last[i])) {
      d.last = next;
      onChange(next);
    }
  };
  const grow = (time: number) => {
    const d = drag.current;
    if (!d) return;
    const side = past(d.clientX);
    if (!side) {
      d.frame = null;
      return;
    }
    const seconds = Math.min(0.1, (time - d.time) / 1000);
    d.time = time;
    d.span = growSpan(d.span, side, seconds, c);
    apply(d);
    d.frame = requestAnimationFrame(grow);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    d.clientX = e.clientX;
    apply(d);
    if (past(e.clientX) && !c.wrap && d.frame === null) {
      d.time = performance.now();
      d.frame = requestAnimationFrame(grow);
    }
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.frame != null) cancelAnimationFrame(d.frame);
    if (d) onCommit(d.last);
  };
  const onKey = (h: Handle) => (e: React.KeyboardEvent) => {
    if (!value) return;
    const dir =
      e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    onCommit(moveHandle(value, h, value[h] + dir * c.step * (e.shiftKey ? 10 : 1), c));
  };
  const polygons = width ? rangePolygons(range, c, width, TRACK_H, span) : [];
  const names = ['start of the rise', 'start of the plateau', 'end of the plateau', 'end of the fall'];
  return (
    <Stack gap="1">
      <HStack justify="space-between">
        <Switch.Root
          size="xs"
          colorPalette="orange"
          checked={!!value}
          onCheckedChange={(d) => onCommit(d.checked ? (restore ?? c.initial) : null)}
          title={c.hint}
        >
          <Switch.HiddenInput aria-label={`Select by ${c.label.toLowerCase()}`} />
          <Switch.Control />
          {/* Short: with a range, its values share the row. */}
          <Switch.Label textStyle="xs">Enable</Switch.Label>
        </Switch.Root>
        <HStack gap="0.5">
          <Text textStyle="2xs" color="fg.muted" fontFamily="numeric" fontVariantNumeric="tabular-nums" mr="1">
            {value ? `${c.format(value[1])} … ${c.format(value[2])}` : 'All'}
          </Text>
          {value && (
            <IconButton
              size="2xs"
              variant={view === 'selection' ? 'subtle' : 'ghost'}
              colorPalette={view === 'selection' ? 'yellow' : 'gray'}
              aria-pressed={view === 'selection'}
              aria-label={`Show where the ${c.label.toLowerCase()} range applies`}
              title={`Show where this ${c.label.toLowerCase()} range applies alone, in yellow`}
              onClick={() => onView(view === 'selection' ? null : 'selection')}
            >
              <ScanEye />
            </IconButton>
          )}
          <IconButton
            size="2xs"
            variant={view === 'values' ? 'subtle' : 'ghost'}
            colorPalette={view === 'values' ? 'orange' : 'gray'}
            aria-pressed={view === 'values'}
            aria-label={`Show the image’s ${c.label.toLowerCase()}`}
            title={`Show the module’s input as ${c.label.toLowerCase()}, in the colours of this track`}
            onClick={() => onView(view === 'values' ? null : 'values')}
          >
            <Eye />
          </IconButton>
        </HStack>
      </HStack>
      <Box
        ref={(el: HTMLDivElement | null) => {
          track.current = el;
          if (el && el.clientWidth !== width) setWidth(el.clientWidth);
        }}
        position="relative"
        h={`${TRACK_H}px`}
        my="1"
        borderRadius="sm"
        style={{ background: c.track(span[0], span[1]), touchAction: 'none' }}
        opacity={value ? 1 : 0.35}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {value && (
          <>
            <svg
              width="100%"
              height={TRACK_H}
              style={{ position: 'absolute', inset: 0, overflow: 'hidden', borderRadius: 'inherit' }}
            >
              {polygons.map((points, i) => (
                <g key={i} style={{ cursor: 'grab' }} onPointerDown={onDown('all')}>
                  <polygon points={points} fill="rgba(255,255,255,.28)" />
                  {/* The rise, plateau and fall; not the bottom edge. */}
                  <polyline points={points} fill="none" stroke="white" strokeWidth={1.5} />
                </g>
              ))}
            </svg>
            {range.map((v, i) => (
              <Box
                key={i}
                role="slider"
                tabIndex={0}
                aria-label={`${c.label}: ${names[i]}`}
                aria-valuemin={c.hardMin}
                aria-valuemax={c.hardMax}
                aria-valuenow={v}
                aria-valuetext={c.format(v)}
                position="absolute"
                left={x(v)}
                top={i === 1 || i === 2 ? '-5px' : undefined}
                bottom={i === 0 || i === 3 ? '-5px' : undefined}
                transform="translateX(-50%)"
                w="2.5"
                h="2.5"
                borderRadius="full"
                bg="white"
                borderWidth="1.5px"
                borderColor="orange.solid"
                boxShadow="xs"
                cursor="ew-resize"
                _focusVisible={{ outline: '2px solid', outlineColor: 'orange.focusRing' }}
                onPointerDown={onDown(i as Handle)}
                onKeyDown={onKey(i as Handle)}
              />
            ))}
          </>
        )}
      </Box>
    </Stack>
  );
}

interface Props {
  kind: ModuleKind;
  id: string;
  mask: Mask;
  /** The type of each drawn part's shape. */
  shapeTypes: (ShapeType | undefined)[];
  ui: ShapeUi;
  /** The recipe now, for handlers (the editor is memoised with its section). */
  params: () => EditParams;
  /** The instance's name, for history labels. */
  title: () => string;
  onChange: (p: EditParams) => void;
  onCommit: (p: EditParams, label?: string) => void;
  onUi: (patch: Partial<ShapeUi>) => void;
  /** Ranges as they were when switched off (kept by the panel, not in the recipe). */
  remembered: Partial<Record<RangeKey, MaskRange>>;
  onRemember: (key: RangeKey, range: MaskRange) => void;
}

/** A group's header, as colour balance's (Saturation, Brilliance). */
function GroupTitle({ children, hint, first }: { children: string; hint: string; first?: boolean }) {
  return (
    <Text
      textStyle="xs"
      fontFamily="label"
      fontWeight="medium"
      textTransform="uppercase"
      letterSpacing="wider"
      color="fg.subtle"
      pt={first ? '0' : '2'}
      title={hint}
    >
      {children}
    </Text>
  );
}

/**
 * An instance's mask (roadmap 4.5): its drawn shapes (edited on the image with the
 * shape tools), its parametric ranges, feather, invert and opacity, how the module's
 * output blends with its input (4.11), and the yellow overlay that shows where it applies.
 */
export function MaskEditor({
  kind,
  id,
  mask,
  shapeTypes,
  ui,
  params,
  title,
  onChange,
  onCommit,
  onUi,
  remembered,
  onRemember,
}: Props) {
  const editing = isEditing(ui, 'mask', id);
  const sel = editing && ui.selected !== null && ui.selected < mask.drawn.length ? ui.selected : null;
  const overlay = ui.maskOverlay?.id === id ? ui.maskOverlay : null;
  const show = (view: MaskView | null) => onUi({ maskOverlay: view && { id, ...view } });
  const hasRanges = RANGE_KEYS.some((k) => mask[k]);
  // The range tab shown: the first range in use when the editor opens.
  const [rangeTab, setRangeTab] = useState<RangeKey>(() => RANGE_KEYS.find((k) => mask[k]) ?? 'luminance');
  /**
   * Another range's tab. A range overlay follows it: the module's input shown as the new
   * range's values, or where the new range applies (if it's on; nothing to show if not).
   */
  const switchRangeTab = (key: RangeKey) => {
    setRangeTab(key);
    if (!overlay || !RANGE_KEYS.includes(overlay.part as RangeKey) || overlay.part === key) return;
    show(overlay.values || mask[key] ? { part: key, values: overlay.values } : null);
  };
  const opSelectId = useId();
  const blendSelectId = useId();
  const display = isDisplayReferred(kind);
  const edit = (patch: Partial<Mask>) => updateMask(params(), kind, id, patch);
  /** Props for a slider bound to a numeric field of the mask. */
  const bind = (key: 'feather' | 'opacity' | 'blendFulcrum') => ({
    value: mask[key],
    defaultValue: defaultMask[key],
    onChange: (v: number) => onChange(edit({ [key]: v })),
    onCommit: (v: number) => onCommit(edit({ [key]: v })),
  });
  return (
    <Stack gap="1.5">
      <Stack gap="1.5" opacity={mask.enabled ? 1 : 0.5}>
        <GroupTitle first hint="Circles, ellipses, gradients, paths and brush strokes drawn on the image">
          Shapes
        </GroupTitle>
        <ShapeToolBar ui={ui} target="mask" id={id} kind={kind} noun="mask shapes" onUi={onUi} />
        {editing && ui.tool !== 'select' && mask.drawn.length > 0 && (
          <HStack gap="2">
            <Text asChild textStyle="xs" color="fg.muted" w="16" flexShrink={0}>
              <label htmlFor={opSelectId}>New shapes</label>
            </Text>
            <NativeSelect.Root size="xs" flex="1">
              <NativeSelect.Field
                id={opSelectId}
                value={ui.maskOp}
                onChange={(ev) => onUi({ maskOp: ev.target.value as ShapeOp })}
                title={OP_TITLES[ui.maskOp]}
              >
                {SHAPE_OPS.map((op) => (
                  <option key={op} value={op}>
                    {OP_LABELS[op]}
                  </option>
                ))}
              </NativeSelect.Field>
              <NativeSelect.Indicator />
            </NativeSelect.Root>
          </HStack>
        )}
        {editing && ui.tool === 'brush' && <BrushSettings ui={ui} onUi={onUi} />}
        {mask.drawn.length > 0 && (
          <Stack gap="0">
            {mask.drawn.map((d, i) => (
              <HStack key={i} gap="1">
                <Button
                  size="2xs"
                  flex="1"
                  justifyContent="flex-start"
                  variant={i === sel ? 'subtle' : 'ghost'}
                  colorPalette={i === sel ? 'orange' : 'gray'}
                  onClick={() => onUi({ editing: true, target: 'mask', instance: id, kind, selected: i })}
                >
                  {i + 1}. {shapeTypes[i] ? SHAPE_LABELS[shapeTypes[i]!] : ''}
                </Button>
                {i > 0 && (
                  <NativeSelect.Root size="xs" w="24">
                    <NativeSelect.Field
                      aria-label={`How shape ${i + 1} combines`}
                      title={OP_TITLES[d.op]}
                      value={d.op}
                      onChange={(ev) => {
                        const drawn = params().modules.find((m) => m.id === id)?.mask?.drawn ?? [];
                        const op = ev.target.value as ShapeOp;
                        onCommit(
                          edit({ drawn: drawn.map((x, j) => (j === i ? { ...x, op } : x)) }),
                          `${title()}: mask shape ${OP_LABELS[op].toLowerCase()}`,
                        );
                      }}
                    >
                      {SHAPE_OPS.map((op) => (
                        <option key={op} value={op}>
                          {OP_LABELS[op]}
                        </option>
                      ))}
                    </NativeSelect.Field>
                    <NativeSelect.Indicator />
                  </NativeSelect.Root>
                )}
                <IconButton
                  size="2xs"
                  variant="ghost"
                  aria-label={`Delete mask shape ${i + 1}`}
                  onClick={() => {
                    onCommit(removeMaskShape(params(), kind, id, i), `${title()}: mask shape removed`);
                    if (sel !== null && sel >= i) onUi({ selected: sel === i ? null : sel - 1 });
                  }}
                >
                  <Trash2 />
                </IconButton>
              </HStack>
            ))}
          </Stack>
        )}
        <GroupTitle hint="Where the module applies by the image's own values: luminance, saturation, hue and channels">
          Parametric
        </GroupTitle>
        {/* Tabs, like colour calibration's: one range at a time, with its controls. */}
        <Tabs.Root size="sm" variant="line" value={rangeTab} onValueChange={(d) => switchRangeTab(d.value as RangeKey)}>
          <Tabs.List aria-label="Mask ranges" gap="0">
            {RANGE_KEYS.map((key) => (
              <Tabs.Trigger
                key={key}
                value={key}
                title={RANGES[key].hint}
                h="7"
                px="1.5"
                flex="auto"
                justifyContent="center"
                textStyle="2xs"
                position="relative"
              >
                {RANGES[key].tab}
                {mask[key] && (
                  <Box
                    position="absolute"
                    top="1"
                    right="0.5"
                    boxSize="1"
                    borderRadius="full"
                    bg="orange.solid"
                    aria-label="on"
                  />
                )}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
        </Tabs.Root>
        {[rangeTab].map((key) => (
          <RangeSlider
            key={key}
            config={RANGES[key]}
            value={mask[key]}
            restore={remembered[key]}
            view={overlay?.part === key ? (overlay.values ? 'values' : 'selection') : null}
            onView={(v) => show(v && { part: key, values: v === 'values' })}
            onChange={(r) => onChange(edit({ [key]: r }))}
            onCommit={(r) => {
              // Switched off: remember it, to bring it back when switched on.
              const was = params().modules.find((m) => m.id === id)?.mask?.[key];
              if (!r && was) onRemember(key, was);
              // Switched off, there's nothing left of the range to show.
              if (!r && overlay?.part === key && !overlay.values) show(null);
              onCommit(edit({ [key]: r }));
            }}
          />
        ))}
        <GroupTitle hint="How the module's output mixes with its input, and how the mask's edge is refined">
          Blending
        </GroupTitle>
        <ParamSlider
          label="Opacity"
          min={0}
          max={1}
          step={0.01}
          scale={100}
          format={(v) => `${Math.round(v * 100)} %`}
          {...bind('opacity')}
        />
        <HStack gap="2">
          <Text asChild textStyle="xs" color="fg.muted" w="16" flexShrink={0}>
            <label htmlFor={blendSelectId}>Blend</label>
          </Text>
          <NativeSelect.Root size="xs" flex="1">
            <NativeSelect.Field
              id={blendSelectId}
              value={mask.blend}
              title={`${BLEND_TITLES[mask.blend]}. ${
                display
                  ? 'After filmic, it blends display-referred (encoded sRGB).'
                  : 'Before filmic, it blends scene-referred (linear).'
              }`}
              onChange={(ev) => {
                const blend = ev.target.value as BlendMode;
                onCommit(edit({ blend }), `${title()}: blend ${BLEND_LABELS[blend].toLowerCase()}`);
              }}
            >
              {BLEND_GROUPS.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.modes.map((mode) => (
                    <option key={mode} value={mode} title={BLEND_TITLES[mode]}>
                      {BLEND_LABELS[mode]}
                    </option>
                  ))}
                </optgroup>
              ))}
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
        </HStack>
        {!display && FULCRUM_BLEND_MODES.includes(mask.blend) && (
          <ParamSlider
            label="Fulcrum"
            min={-3}
            max={3}
            hardMin={-10}
            hardMax={10}
            step={0.05}
            format={signedEv}
            {...bind('blendFulcrum')}
          />
        )}
        {(mask.drawn.length > 0 || hasRanges) && (
          <>
            <ParamSlider
              label="Feather"
              min={0}
              max={200}
              hardMax={1000}
              step={1}
              format={(v) => `${v.toFixed(0)} px`}
              {...bind('feather')}
            />
            <Switch.Root
              size="xs"
              colorPalette="orange"
              checked={mask.edgeAware}
              disabled={mask.feather <= 0}
              onCheckedChange={(d) => onCommit(edit({ edgeAware: d.checked }))}
              title={
                hasRanges
                  ? 'The feathered mask follows the image’s edges (a guided filter), rather than a plain blur. With ranges, the mask is computed with the spatial stages: edits before this module re-render like spatial edits.'
                  : 'The feathered edge follows the image’s edges (a guided filter), rather than a plain blur'
              }
            >
              <Switch.HiddenInput />
              <Switch.Control />
              <Switch.Label textStyle="2xs" color="fg.muted">
                Follow the image’s edges
              </Switch.Label>
            </Switch.Root>
          </>
        )}
        <Switch.Root
          size="xs"
          colorPalette="orange"
          checked={mask.invert}
          onCheckedChange={(d) => onCommit(edit({ invert: d.checked }))}
        >
          <Switch.HiddenInput />
          <Switch.Control />
          <Switch.Label textStyle="2xs" color="fg.muted">
            Invert
          </Switch.Label>
        </Switch.Root>
      </Stack>
    </Stack>
  );
}
