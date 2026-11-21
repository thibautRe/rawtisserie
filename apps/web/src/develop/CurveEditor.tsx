import { Box, HStack, Text } from '@chakra-ui/react';
import { useRef, useState } from 'react';
import { curveAt } from './curve.ts';

interface Props {
  /** Node values, 0 … 1, evenly spaced from left to right. */
  values: readonly number[];
  defaults: readonly number[];
  /** Drawn as a dashed line: the value that leaves the image alone. */
  neutral: number;
  /** Labels under the left and right ends. */
  left: string;
  right: string;
  label: string;
  /** The curve's colour (orange by default). */
  color?: string;
  /** Other curves, drawn faintly behind. */
  others?: readonly { values: readonly number[]; color: string }[];
  /** Drawn behind the curve: heights 0 … 1, evenly spread from the left end to the right one. */
  histogram?: readonly number[];
  /**
   * Drawn over the graph, in its coordinates (a `CurveMarks`): it may change more
   * often than the curve (the colour picker's marker reads a store of its own).
   */
  overlay?: React.ReactNode;
  /** Called when a node gets focus (pressed, or picked with the arrow keys) or loses it. */
  onFocusChange?: (node: number | null) => void;
  /** Describes the focused node (by index) and its value, shown under the curve. */
  format?: (node: number, value: number) => string;
  disabled?: boolean;
  onChange: (values: number[]) => void;
  onCommit: (values: number[]) => void;
}

const W = 240;
const H = 96;
const PAD = 6;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Drag nodes of a curve up and down. A press anywhere grabs the nearest node;
 * double-click resets it. Arrow keys move the focused node (Shift: ×10).
 */
export function CurveEditor({
  values,
  defaults,
  neutral,
  left,
  right,
  label,
  color,
  others = [],
  histogram,
  overlay,
  format,
  onFocusChange,
  disabled,
  onChange,
  onCommit,
}: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const dragging = useRef<{ node: number; values: number[] } | null>(null);
  const [focused, setFocusedState] = useState<number | null>(null);
  const setFocused = (node: number | null) => {
    setFocusedState(node);
    if (node !== focused) onFocusChange?.(node);
  };

  const px = (i: number) => PAD + (i / (values.length - 1)) * (W - 2 * PAD);
  const py = (v: number) => PAD + (1 - v) * (H - 2 * PAD);

  /** The node nearest to the pointer, and the value under it. */
  const locate = (e: React.PointerEvent | React.MouseEvent) => {
    const r = svg.current!.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    const y = ((e.clientY - r.top) / r.height) * H;
    const node = clamp(Math.round(((x - PAD) / (W - 2 * PAD)) * (values.length - 1)), 0, values.length - 1);
    return { node, value: clamp(1 - (y - PAD) / (H - 2 * PAD), 0, 1) };
  };

  const set = (node: number, value: number) => values.map((v, i) => (i === node ? Math.round(value * 1000) / 1000 : v));

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (disabled || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const { node, value } = locate(e);
    const next = set(node, value);
    dragging.current = { node, values: next };
    setFocused(node);
    onChange(next);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragging.current;
    if (!d) return;
    d.values = set(d.node, locate(e).value);
    onChange(d.values);
  };

  const onPointerUp = () => {
    const d = dragging.current;
    dragging.current = null;
    if (d) onCommit(d.values);
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (disabled) return;
    const { node } = locate(e);
    onCommit(set(node, defaults[node]!));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    const node = focused ?? 0;
    const step = e.shiftKey ? 0.1 : 0.01;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      onCommit(set(node, clamp(values[node]! + (e.key === 'ArrowUp' ? step : -step), 0, 1)));
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      setFocused(clamp(node + (e.key === 'ArrowRight' ? 1 : -1), 0, values.length - 1));
    }
  };

  const samples = 64;
  const path = (nodes: readonly number[]) =>
    Array.from({ length: samples + 1 }, (_, k) => {
      const x = k / samples;
      return `${k === 0 ? 'M' : 'L'}${(PAD + x * (W - 2 * PAD)).toFixed(1)},${py(curveAt(nodes, x)).toFixed(1)}`;
    }).join(' ');

  return (
    <Box opacity={disabled ? 0.5 : 1} position="relative">
      <Box
        asChild
        w="full"
        h="auto"
        display="block"
        bg="bg.muted"
        borderRadius="sm"
        cursor={disabled ? 'default' : 'ns-resize'}
        touchAction="none"
        outline="none"
        _focusVisible={{ boxShadow: '0 0 0 2px var(--chakra-colors-orange-solid)' }}
      >
        <svg
          ref={svg}
          viewBox={`0 0 ${W} ${H}`}
          role="group"
          aria-label={label}
          tabIndex={disabled ? -1 : 0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onDoubleClick={onDoubleClick}
          onKeyDown={onKeyDown}
          onBlur={() => setFocused(null)}
        >
          {values.map((_, i) => (
            <line
              key={i}
              x1={px(i)}
              x2={px(i)}
              y1={PAD}
              y2={H - PAD}
              stroke="var(--chakra-colors-border)"
              strokeWidth="1"
            />
          ))}
          {histogram && histogram.length > 1 && (
            <path
              d={`M${PAD},${H - PAD} ${histogram
                .map(
                  (h, k) => `L${(PAD + (k / (histogram.length - 1)) * (W - 2 * PAD)).toFixed(1)},${py(h).toFixed(1)}`,
                )
                .join(' ')} L${W - PAD},${H - PAD} Z`}
              fill="var(--chakra-colors-fg)"
              fillOpacity={0.1}
            />
          )}
          <line
            x1={PAD}
            x2={W - PAD}
            y1={py(neutral)}
            y2={py(neutral)}
            stroke="var(--chakra-colors-fg-subtle)"
            strokeDasharray="3 3"
            strokeWidth="1"
          />
          {/* 1 CSS px whatever the panel's width, as the sliders' tracks. */}
          {others.map((o, i) => (
            <path
              key={i}
              d={path(o.values)}
              fill="none"
              stroke={o.color}
              strokeOpacity={0.45}
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <path
            d={path(values)}
            fill="none"
            stroke={color ?? 'var(--chakra-colors-orange-solid)'}
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
          {values.map((v, i) => (
            <circle
              key={i}
              cx={px(i)}
              cy={py(v)}
              r={focused === i ? 4 : 3}
              fill={v === defaults[i] ? 'var(--chakra-colors-fg-muted)' : (color ?? 'var(--chakra-colors-orange-fg)')}
            />
          ))}
        </svg>
      </Box>
      {overlay}
      <HStack justify="space-between">
        <Text textStyle="2xs" color="fg.subtle">
          {left}
        </Text>
        {format && focused !== null && (
          <Text textStyle="2xs" color="fg.muted">
            {format(focused, values[focused]!)}
          </Text>
        )}
        <Text textStyle="2xs" color="fg.subtle">
          {right}
        </Text>
      </HStack>
    </Box>
  );
}

/**
 * Marks over a `CurveEditor`'s graph (its `overlay`): vertical lines at `at` (0 … 1
 * along the nodes' range), each with a dot where it crosses the curve (`values`). Out of
 * the range, a short tick at that end.
 */
export function CurveMarks({
  values,
  marks,
}: {
  values: readonly number[];
  /** `pin`: a pinned sample's number (dashed, labelled); none for the pointer's. */
  marks: readonly { at: number; color: string; pin?: number }[];
}) {
  if (!marks.length) return null;
  const py = (v: number) => PAD + (1 - v) * (H - 2 * PAD);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        aspectRatio: `${W} / ${H}`,
        pointerEvents: 'none',
      }}
      aria-hidden
      data-curve-marks
    >
      {marks.map(({ at, color, pin }, i) => {
        const inside = at >= 0 && at <= 1;
        const u = clamp(at, 0, 1);
        const x = PAD + u * (W - 2 * PAD);
        return inside ? (
          <g key={i}>
            <line
              x1={x}
              x2={x}
              y1={PAD}
              y2={H - PAD}
              stroke={color}
              strokeOpacity={pin ? 0.5 : 0.7}
              strokeDasharray={pin ? '2 2' : undefined}
              strokeWidth="1"
            />
            <circle
              cx={x}
              cy={py(curveAt(values, u))}
              r={pin ? 2 : 2.5}
              fill={color}
              stroke="black"
              strokeOpacity={0.5}
            />
            {pin && (
              <text x={x + 2} y={PAD + 7} fontSize={7} fill={color} fontFamily="var(--chakra-fonts-numeric)">
                {pin}
              </text>
            )}
          </g>
        ) : (
          <line key={i} x1={x} x2={x} y1={H - PAD - 8} y2={H - PAD} stroke={color} strokeWidth="2" />
        );
      })}
    </svg>
  );
}
