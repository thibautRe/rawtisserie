import { type Point, type SensorMapping, fromSensor, toSensor } from '@rawtisserie/pipeline';
import { useLayoutEffect, useRef, useState } from 'react';
import type { GuideLine } from './protocol.ts';

interface Props {
  lines: GuideLine[];
  /** How the shown image maps to the sensor frame, where the lines' endpoints are. */
  mapping: SensorMapping;
  /** Size of the stage, CSS pixels (unzoomed). */
  width: number;
  height: number;
  /** The stage's zoom (CSS transform): lines and handles keep their size on screen. */
  zoom: number;
  /** After each change: a line toggled, drawn, moved or removed. */
  onChange: (lines: GuideLine[]) => void;
}

const VERTICAL = '#3ddc84';
const HORIZONTAL = '#4ba3ff';
const UNSELECTED = 'rgba(255,255,255,.6)';
/** Screen pixels: how close a press must be to a line or an endpoint, and how far a drag must go to draw. */
const LINE_HIT = 6;
const END_HIT = 8;
const MIN_DRAG = 8;

type Drag =
  /** Pressed on a line: a click toggles it, moving draws a new line from there. */
  | { kind: 'press'; index: number; from: Point; to: Point }
  | { kind: 'draw'; from: Point; to: Point }
  | { kind: 'end'; index: number; end: 'a' | 'b'; to: Point };

/**
 * Perspective guides over the image (the stage, zoomed like it): the lines a fit
 * straightens, selected ones in colour (green: vertical, blue: horizontal), the others
 * dashed. A click toggles a line, dragging on the image draws one (vertical or
 * horizontal by its direction), dragging an endpoint moves it, a right-click removes a
 * line. Endpoints are in the sensor frame and go through `mapping`, so the lines follow
 * the correction as it is fitted.
 *
 * Left-button presses are its own (`data-no-pan`); the middle button still pans.
 */
export function GuideOverlay(props: Props) {
  const { lines, mapping: m, width, height, zoom } = props;
  const svg = useRef<SVGSVGElement>(null);
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  const [drag, setDragState] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const setDrag = (d: Drag | null) => {
    dragRef.current = d;
    setDragState(d);
  };
  const [hover, setHover] = useState<number | null>(null);

  /** Sensor point → stage pixels. */
  const disp = (p: Point): Point => {
    const [x, y] = fromSensor(m, p[0], p[1]);
    return [x * width, y * height];
  };
  /** Stage pixels → sensor point. */
  const sensor = (p: Point): Point => toSensor(latest.current.mapping, p[0] / width, p[1] / height);
  /** A pointer position in stage pixels. */
  const at = (e: { clientX: number; clientY: number }): Point => {
    const r = svg.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * width, ((e.clientY - r.top) / r.height) * height];
  };
  /** A line's ends in stage pixels, with a drag's change. */
  const ends = (line: GuideLine, index: number): [Point, Point] => {
    const d = dragRef.current;
    const [a, b] = [disp(line.a), disp(line.b)];
    if (d?.kind === 'end' && d.index === index) return d.end === 'a' ? [d.to, b] : [a, d.to];
    return [a, b];
  };

  /** The endpoint near `p`, if any, else the line near it. */
  const hit = (p: Point): { index: number; end?: 'a' | 'b' } | null => {
    const near = (q: Point, r: number) => Math.hypot(q[0] - p[0], q[1] - p[1]) <= r / zoom;
    let best: { index: number; distance: number } | null = null;
    for (let i = latest.current.lines.length - 1; i >= 0; i--) {
      const [a, b] = ends(latest.current.lines[i]!, i);
      if (near(a, END_HIT)) return { index: i, end: 'a' };
      if (near(b, END_HIT)) return { index: i, end: 'b' };
      const distance = segmentDistance(p, a, b);
      if (distance <= LINE_HIT / zoom && (!best || distance < best.distance)) best = { index: i, distance };
    }
    return best && { index: best.index };
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = at(e);
    const h = hit(p);
    if (h?.end) setDrag({ kind: 'end', index: h.index, end: h.end, to: p });
    else if (h) setDrag({ kind: 'press', index: h.index, from: p, to: p });
    else setDrag({ kind: 'draw', from: p, to: p });
  };

  const onMove = (e: React.PointerEvent) => {
    const p = at(e);
    const d = dragRef.current;
    if (!d) {
      const h = hit(p);
      if ((h?.index ?? null) !== hover) setHover(h?.index ?? null);
      return;
    }
    if (d.kind === 'press') {
      // Moved away from the line: drawing a new one.
      const moved = Math.hypot(p[0] - d.from[0], p[1] - d.from[1]) > MIN_DRAG / zoom;
      setDrag(moved ? { kind: 'draw', from: d.from, to: p } : { ...d, to: p });
    } else setDrag({ ...d, to: p });
  };

  const onUp = () => {
    const d = dragRef.current;
    setDrag(null);
    if (!d) return;
    const { lines, onChange } = latest.current;
    if (d.kind === 'press') {
      onChange(lines.map((l, i) => (i === d.index ? { ...l, selected: !l.selected } : l)));
    } else if (d.kind === 'draw') {
      const [dx, dy] = [d.to[0] - d.from[0], d.to[1] - d.from[1]];
      if (Math.hypot(dx, dy) < MIN_DRAG / zoom) return;
      const line = {
        a: sensor(d.from),
        b: sensor(d.to),
        vertical: Math.abs(dy) > Math.abs(dx),
        selected: true,
        drawn: true,
      };
      onChange([...lines, line]);
    } else {
      const line = lines[d.index]!;
      const [a, b] = ends(line, d.index).map((p, k) => (k === (d.end === 'a' ? 0 : 1) ? d.to : p)) as [Point, Point];
      const moved: GuideLine = {
        ...line,
        [d.end]: sensor(d.to),
        vertical: Math.abs(b[1] - a[1]) > Math.abs(b[0] - a[0]),
        selected: true,
      };
      onChange(lines.map((l, i) => (i === d.index ? moved : l)));
    }
  };

  const onContextMenu = (e: React.MouseEvent) => {
    const h = hit(at(e));
    if (!h) return;
    e.preventDefault();
    const { lines, onChange } = latest.current;
    setHover(null);
    onChange(lines.filter((_, i) => i !== h.index));
  };

  const draw = (line: GuideLine, i: number) => {
    const [a, b] = ends(line, i);
    const color = !line.selected ? UNSELECTED : line.vertical ? VERTICAL : HORIZONTAL;
    const hovered = hover === i && !drag;
    const w = (hovered ? 2.5 : 1.5) / zoom;
    const showEnds = hovered || line.drawn || (drag?.kind === 'end' && drag.index === i);
    return (
      <g key={i}>
        <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="rgba(0,0,0,.5)" strokeWidth={w + 2 / zoom} />
        <line
          x1={a[0]}
          y1={a[1]}
          x2={b[0]}
          y2={b[1]}
          stroke={color}
          strokeWidth={w}
          strokeDasharray={line.selected ? undefined : `${4 / zoom} ${3 / zoom}`}
        />
        {showEnds &&
          [a, b].map((p, k) => (
            <circle
              key={k}
              cx={p[0]}
              cy={p[1]}
              r={3.5 / zoom}
              fill="white"
              stroke={line.selected ? color : 'rgba(0,0,0,.6)'}
              strokeWidth={1.5 / zoom}
            />
          ))}
      </g>
    );
  };

  return (
    <svg
      ref={svg}
      data-no-pan=""
      viewBox={`0 0 ${width} ${height}`}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        cursor: hover !== null ? 'pointer' : 'crosshair',
        touchAction: 'none',
      }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={() => setDrag(null)}
      onPointerLeave={() => setHover(null)}
      onContextMenu={onContextMenu}
    >
      {lines.map(draw)}
      {drag?.kind === 'draw' && (
        <line
          x1={drag.from[0]}
          y1={drag.from[1]}
          x2={drag.to[0]}
          y2={drag.to[1]}
          stroke={Math.abs(drag.to[1] - drag.from[1]) > Math.abs(drag.to[0] - drag.from[0]) ? VERTICAL : HORIZONTAL}
          strokeWidth={1.5 / zoom}
        />
      )}
    </svg>
  );
}

/** Distance from `p` to the segment `a`–`b`. */
function segmentDistance(p: Point, a: Point, b: Point): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
