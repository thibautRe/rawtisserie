import {
  type BrushPoint,
  type EditParams,
  type GeometricShape,
  type PathNode,
  type Point,
  type SensorMapping,
  type Shape,
  addMaskShape,
  addSpot,
  flattenPath,
  fromSensor,
  isRasterShape,
  maskOf,
  removeMaskShape,
  removeSpot,
  shapeCenter,
  shapeOutline,
  simplifyStroke,
  spotsOf,
  toSensor,
  translateShape,
  updateShape,
  updateSpot,
} from '@rawtisserie/pipeline';
import { Button, HStack, Text } from '@chakra-ui/react';
import { Check, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MODULE_TITLES, instanceTitle } from './changes.ts';
import { CLICK_RADIUS_PX, type ShapeUi, defaultSource, displayScale, round } from './retouch.ts';

/** One of the edited shapes: a retouch spot (with its source, for heal and clone) or a mask's drawn part. */
interface Item {
  shape: string;
  source?: [number, number];
}

/** What the overlay edits: the spots of a retouch instance, or the drawn part of an instance's mask. */
interface Target {
  /** For history labels. */
  noun: string;
  items: (p: EditParams) => Item[];
  /** `p` with a new item of `shape`, whose half size around `center` is `extent`. */
  add: (p: EditParams, shape: Shape, center: Point, extent: Point) => EditParams;
  remove: (p: EditParams, index: number) => EditParams;
  setSource: (p: EditParams, index: number, source: [number, number]) => EditParams;
}

function target(ui: ShapeUi): Target {
  if (ui.target === 'mask') {
    return {
      noun: 'mask shape',
      items: (p) => (maskOf(p, ui.instance)?.drawn ?? []).map((d) => ({ shape: d.shape })),
      add: (p, shape) => addMaskShape(p, ui.kind, ui.instance, shape, ui.maskOp)[0],
      remove: (p, i) => removeMaskShape(p, ui.kind, ui.instance, i),
      setSource: (p) => p,
    };
  }
  return {
    noun: 'spot',
    items: (p) =>
      spotsOf(p, ui.instance).map((s) => ({
        shape: s.shape,
        source: s.mode === 'heal' || s.mode === 'clone' ? s.source : undefined,
      })),
    add: (p, shape, center, extent) =>
      addSpot(p, ui.instance, shape, { mode: ui.mode, source: defaultSource(center, extent) })[0],
    remove: (p, i) => removeSpot(p, ui.instance, i),
    setSource: (p, i, source) => updateSpot(p, ui.instance, i, { source }),
  };
}

interface Props {
  params: EditParams;
  mapping: SensorMapping;
  /** Size of the displayed (fitted) image, in CSS pixels before zoom. */
  width: number;
  height: number;
  /** Screen pixels per CSS pixel of the fitted image (the zoom). */
  zoom: number;
  ui: ShapeUi;
  onUi: (patch: Partial<ShapeUi>) => void;
  onChange: (p: EditParams) => void;
  /** Commit a change as its own history entry. */
  onCommit: (p: EditParams, label: string) => void;
  /**
   * Only shown (the compared image's copy of the edited one's shapes): no key handling,
   * which the edited image's overlay does. Put it in an `inert` element: its handles
   * would catch the pointer otherwise.
   */
  readOnly?: boolean;
  /** Where the path tool's bar goes (below the image, outside the zoomed stage). */
  bar?: HTMLElement | null;
}

type Handle = 'rx' | 'ry' | 'rotate' | 'feather' | { node: number; part: 'at' | 'in' | 'out' };

/** What a pointer drag is doing; `base` is the recipe it started from. */
type Drag =
  | { kind: 'move'; index: number; id: string; shape: GeometricShape; base: EditParams; start: Point; moved: boolean }
  | { kind: 'source'; index: number; source: [number, number]; base: EditParams; start: Point; moved: boolean }
  | {
      kind: 'handle';
      id: string;
      shape: GeometricShape;
      handle: Handle;
      /** Alt: an ellipse's axes change independently, even if it is a circle. */
      free: boolean;
      base: EditParams;
      moved: boolean;
    }
  | { kind: 'create'; ellipse: boolean; base: EditParams; start: Point; moved: boolean; result: EditParams | null }
  /** A gradient, from where it applies fully (`start`) to where it doesn't. */
  | { kind: 'gradient'; base: EditParams; start: Point; moved: boolean; result: EditParams | null }
  | { kind: 'brush'; base: EditParams; points: BrushPoint[]; result: EditParams | null }
  /** Pulling the control points out of the path draft's last node. */
  | { kind: 'node'; start: Point; moved: boolean };

const ORANGE = '#f97316';
const HANDLE_PX = 5;
/** Width of the invisible strokes that catch the pointer around outlines, in screen pixels. */
const HIT_PX = 10;
/** Clicking this close to a path draft's first node closes it (screen pixels). */
const CLOSE_PX = 8;

const r6 = (p: Point): Point => [round(p[0]), round(p[1])];

/**
 * Retouch spots or mask shapes drawn over the image, in the (zoomed) stage: each shape,
 * a spot's source for heal and clone, and handles on the selected one. Shapes are in
 * sensor coordinates and go through the frame's `mapping`, so they follow the crop,
 * rotation and lens correction. The shape tools add shapes: a click or drag (circle,
 * ellipse, gradient), a stroke (brush), or nodes clicked in turn (path, closed on its
 * first node or Enter).
 *
 * Lines and handles keep their size on screen: the stage is zoomed with a CSS transform,
 * which `vector-effect` doesn't undo, so their sizes are divided by the zoom.
 *
 * Left-button presses on shapes (and anywhere while a tool is active) are marked
 * `data-no-pan`, so that they don't pan the zoomed view; the middle button still pans.
 */
export function ShapeOverlay(props: Props) {
  const { params, mapping: m, width, height, zoom, ui } = props;
  const svg = useRef<SVGSVGElement>(null);
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  const drag = useRef<Drag | null>(null);
  const [draft, setDraftState] = useState<PathNode[] | null>(null);
  const draftRef = useRef<PathNode[] | null>(null);
  const setDraft = (d: PathNode[] | null) => {
    draftRef.current = d;
    setDraftState(d);
  };
  /** Nodes taken off the path draft by undo, last first, for redo. */
  const undone = useRef<PathNode[]>([]);
  /** Where the pointer is over the image with the path tool: the next node's place. */
  const [hover, setHover] = useState<Point | null>(null);

  const sensor = { width: m.width, height: m.height };
  const unit = Math.min(m.width, m.height);
  /** Sensor point → stage CSS pixels. */
  const disp = (p: Point): Point => {
    const [x, y] = fromSensor(m, p[0], p[1]);
    return [x * width, y * height];
  };
  /** A pointer position → sensor point. */
  const at = (e: { clientX: number; clientY: number }): Point => {
    const r = svg.current!.getBoundingClientRect();
    return toSensor(latest.current.mapping, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  };
  /** Screen pixels → sensor length units (fractions of the short side) around `p`. */
  const lengthOf = (screenPx: number, p: Point) => screenPx / (zoom * displayScale(m, p, width, height));
  /** The edited instance's name, for history labels. */
  const title = () => {
    const { params, ui } = latest.current;
    const m = params.modules.find((x) => x.id === ui.instance);
    return m ? instanceTitle(params, m) : MODULE_TITLES[ui.kind];
  };
  /** What is edited, as the overlay's props say now. */
  const edited = () => target(latest.current.ui);
  /** An SVG path through sensor points. A single point (a brush dot) is a zero-length
   * segment, which round caps draw as a dot; a lone `M` would draw nothing. */
  const line = (points: Point[], closed: boolean): string =>
    points.length === 1
      ? line([points[0]!, points[0]!], false)
      : points.length
        ? `M${points
            .map((p) =>
              disp(p)
                .map((v) => v.toFixed(2))
                .join(' '),
            )
            .join('L')}${closed ? 'Z' : ''}`
        : '';
  /** A point `along` and `across` an ellipse's axes from its centre (sensor length units). */
  const onAxes = (shape: Extract<Shape, { type: 'ellipse' }>, along: number, across: number): Point => {
    const [s, c] = [Math.sin(shape.rotation), Math.cos(shape.rotation)];
    return [
      shape.center[0] + ((along * c - across * s) * unit) / m.width,
      shape.center[1] + ((along * s + across * c) * unit) / m.height,
    ];
  };
  /** A point `px` screen pixels beyond `p`, away from `from` (both sensor points), in stage pixels. */
  const beyond = (from: Point, p: Point, px: number): Point => {
    const [a, b] = [disp(from), disp(p)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [b[0] + ((b[0] - a[0]) / len) * (px / zoom), b[1] + ((b[1] - a[1]) / len) * (px / zoom)];
  };

  // ── Changing shapes ──

  /** `shape` with `handle` dragged to sensor point `p`. */
  const withHandle = (shape: GeometricShape, handle: Handle, p: Point, free: boolean): GeometricShape => {
    if (typeof handle === 'object') {
      if (shape.type !== 'path') return shape;
      const points = shape.points.map((n, i) => {
        if (i !== handle.node) return n;
        if (handle.part === 'in') return [n[0], n[1], p[0], p[1], n[4], n[5]] as PathNode;
        if (handle.part === 'out') return [n[0], n[1], n[2], n[3], p[0], p[1]] as PathNode;
        const [dx, dy] = [p[0] - n[0], p[1] - n[1]];
        return n.map((v, k) => round(v + (k % 2 ? dy : dx))) as PathNode;
      });
      return { ...shape, points: points.map((n) => n.map(round) as PathNode) };
    }
    const c = shapeCenter(shape);
    // Offset in sensor length units.
    const [px, py] = [((p[0] - c[0]) * m.width) / unit, ((p[1] - c[1]) * m.height) / unit];
    if (shape.type === 'ellipse') {
      const [s, co] = [Math.sin(shape.rotation), Math.cos(shape.rotation)];
      const [u, v] = [px * co + py * s, -px * s + py * co];
      const [rx, ry] = shape.radii;
      const min = 5e-4;
      if (handle === 'rotate') return { ...shape, rotation: round(Math.atan2(py, px)) };
      if (handle === 'feather') return { ...shape, feather: round(Math.max(0, Math.abs(u) - rx)) };
      const circle = rx === ry && !free;
      if (circle) {
        const r = round(Math.max(min, Math.hypot(u, v)));
        return { ...shape, radii: [r, r] };
      }
      return {
        ...shape,
        radii: handle === 'rx' ? [round(Math.max(min, Math.abs(u))), ry] : [rx, round(Math.max(min, Math.abs(v)))],
      };
    }
    if (shape.type === 'gradient') {
      if (handle === 'rotate') return { ...shape, angle: round(Math.atan2(py, px)) };
      const along = px * Math.cos(shape.angle) + py * Math.sin(shape.angle);
      return { ...shape, feather: round(Math.max(0, 2 * Math.abs(along))) };
    }
    return shape;
  };

  const commitNew = (recipe: EditParams) => {
    const t = edited();
    latest.current.onCommit(recipe, `${title()}: ${t.noun} added`);
    latest.current.onUi({ selected: t.items(recipe).length - 1 });
  };

  /** Close the path draft into a shape (three nodes at least), and leave the path tool. */
  const closePath = () => {
    const nodes = draftRef.current;
    if (!nodes || nodes.length < 3) return;
    setDraft(null);
    undone.current = [];
    latest.current.onUi({ tool: 'select' });
    const shape: Shape = {
      type: 'path',
      points: nodes.map((n) => n.map(round) as PathNode),
      feather: 0.005,
      opacity: 1,
    };
    const xs = nodes.map((n) => n[0]);
    const ys = nodes.map((n) => n[1]);
    const extent: Point = [(Math.max(...xs) - Math.min(...xs)) / 2, (Math.max(...ys) - Math.min(...ys)) / 2];
    commitNew(edited().add(latest.current.params, shape, shapeCenter(shape), extent));
  };

  // ── Pointer ──

  const capture = (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
  };

  const startMove = (index: number, id: string, shape: GeometricShape) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    capture(e);
    latest.current.onUi({ selected: index });
    drag.current = { kind: 'move', index, id, shape, base: latest.current.params, start: at(e), moved: false };
  };

  const startSource = (index: number, source: [number, number]) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    capture(e);
    latest.current.onUi({ selected: index });
    drag.current = { kind: 'source', index, source, base: latest.current.params, start: at(e), moved: false };
  };

  const startHandle = (id: string, shape: GeometricShape, handle: Handle) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    capture(e);
    drag.current = { kind: 'handle', id, shape, handle, free: e.altKey, base: latest.current.params, moved: false };
  };

  /** A press on the image itself, with a tool: start a new spot. */
  const onRootDown = (e: React.PointerEvent) => {
    const { tool } = latest.current.ui;
    if (e.button !== 0 || tool === 'select') return;
    capture(e);
    const p = at(e);
    const base = latest.current.params;
    if (tool === 'circle' || tool === 'ellipse') {
      drag.current = { kind: 'create', ellipse: tool === 'ellipse', base, start: p, moved: false, result: null };
    } else if (tool === 'gradient') {
      drag.current = { kind: 'gradient', base, start: p, moved: false, result: null };
    } else if (tool === 'brush') {
      const { brushSize, brushHardness } = latest.current.ui;
      const point: BrushPoint = [p[0], p[1], lengthOf(brushSize, p), brushHardness];
      drag.current = { kind: 'brush', base, points: [point], result: null };
      update(drag.current);
    } else if (tool === 'path') {
      const nodes = draftRef.current ?? [];
      const first = nodes[0];
      if (first && nodes.length >= 3) {
        const [a, b] = [disp([first[0], first[1]]), disp(p)];
        if (Math.hypot(a[0] - b[0], a[1] - b[1]) * zoom <= CLOSE_PX) {
          drag.current = null;
          return closePath();
        }
      }
      setDraft([...nodes, [p[0], p[1], p[0], p[1], p[0], p[1]]]);
      undone.current = [];
      setHover(null);
      drag.current = { kind: 'node', start: p, moved: false };
    }
  };

  /** Show what drag `d` gives at pointer position `p`. */
  const update = (d: Drag, p?: Point) => {
    const { onChange } = latest.current;
    if (d.kind === 'brush') {
      const shape: Shape = { type: 'brush', points: d.points, opacity: 1 };
      const r = d.points[0]![2];
      d.result = edited().add(d.base, shape, shapeCenter(shape), [r, r]);
      return onChange(d.result);
    }
    if (!p) return;
    if (d.kind === 'node') {
      const nodes = draftRef.current;
      if (!nodes?.length) return;
      const [x, y] = nodes.at(-1)!;
      // Smooth node: the in handle mirrors the out handle.
      setDraft([...nodes.slice(0, -1), [x, y, 2 * x - p[0], 2 * y - p[1], p[0], p[1]]]);
      return;
    }
    if (d.kind === 'create') {
      const r = Math.max(
        1e-3,
        Math.hypot(((p[0] - d.start[0]) * m.width) / unit, ((p[1] - d.start[1]) * m.height) / unit),
      );
      d.result = create(d.base, d.start, r, d.ellipse);
      return onChange(d.result);
    }
    if (d.kind === 'gradient') {
      d.result = gradient(d.base, d.start, p);
      return onChange(d.result);
    }
    if (d.kind === 'move') {
      const shape = translateShape(d.shape, p[0] - d.start[0], p[1] - d.start[1]);
      return onChange(updateShape(d.base, d.id, roundShape(shape)));
    }
    if (d.kind === 'source') {
      const source: [number, number] = [round(d.source[0] + p[0] - d.start[0]), round(d.source[1] + p[1] - d.start[1])];
      return onChange(edited().setSource(d.base, d.index, source));
    }
    if (d.kind === 'handle') return onChange(updateShape(d.base, d.id, withHandle(d.shape, d.handle, p, d.free)));
  };

  /** A new circle or ellipse spot of radius `r` (sensor length units) at `center`. */
  const create = (base: EditParams, center: Point, r: number, ellipse: boolean): EditParams => {
    const radii: [number, number] = [round(r), round(ellipse ? r * 0.6 : r)];
    const shape: Shape = {
      type: 'ellipse',
      center: r6(center),
      radii,
      rotation: 0,
      feather: round(r * 0.25),
      opacity: 1,
    };
    const extent: Point = [(r * 1.25 * unit) / m.width, (r * 1.25 * unit) / m.height];
    return edited().add(base, shape, center, extent);
  };

  /**
   * A new gradient that applies fully at sensor point `from` and not at all at `to`;
   * without `to` (a click), one rising towards the top of the screen over 150 px.
   */
  const gradient = (base: EditParams, from: Point, to?: Point): EditParams => {
    if (!to) {
      const [x, y] = disp(from);
      const below = toSensor(latest.current.mapping, x / width, (y + 75 / zoom) / height);
      const above = toSensor(latest.current.mapping, x / width, (y - 75 / zoom) / height);
      return gradient(base, above, below);
    }
    // In sensor length units, pointing towards `from`.
    const [dx, dy] = [((from[0] - to[0]) * m.width) / unit, ((from[1] - to[1]) * m.height) / unit];
    const anchor: Point = r6([(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]);
    const shape: Shape = {
      type: 'gradient',
      anchor,
      angle: round(Math.atan2(dy, dx)),
      feather: round(Math.max(1e-3, Math.hypot(dx, dy))),
      opacity: 1,
    };
    return edited().add(base, shape, anchor, [0, 0]);
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) {
      if (latest.current.ui.tool === 'path') setHover(at(e));
      return;
    }
    const p = at(e);
    if (d.kind === 'brush') {
      const last = d.points.at(-1)!;
      const step = Math.hypot(((p[0] - last[0]) * m.width) / unit, ((p[1] - last[1]) * m.height) / unit);
      if (step < last[2] / 4) return;
      d.points = [...d.points, [p[0], p[1], last[2], last[3]]];
      return update(d);
    }
    if (!d.moved) {
      // A few pixels of slop, so that a click stays a click.
      if ('start' in d) {
        const [a, b] = [disp(d.start), disp(p)];
        if (Math.hypot(a[0] - b[0], a[1] - b[1]) * zoom < 3) return;
      }
      d.moved = true;
    }
    update(d, p);
  };

  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const { onCommit, onChange } = latest.current;
    const p = at(e);
    if (e.type === 'pointercancel') {
      if (d.kind !== 'node') onChange(d.base);
      return;
    }
    switch (d.kind) {
      case 'create': {
        // A click places a spot of the default size.
        const recipe = d.result ?? create(d.base, d.start, lengthOf(CLICK_RADIUS_PX, d.start), d.ellipse);
        return commitNew(recipe);
      }
      case 'gradient':
        return commitNew(d.result ?? gradient(d.base, d.start));
      case 'brush': {
        const points = simplifyStroke(d.points, 0.5, [m.width, m.height]).map(
          ([x, y, r, h]) => [round(x), round(y), round(r), h] as BrushPoint,
        );
        const shape: Shape = { type: 'brush', points, opacity: 1 };
        const xs = points.map((q) => q[0]);
        const ys = points.map((q) => q[1]);
        const extent: Point = [
          (Math.max(...xs) - Math.min(...xs)) / 2 + (points[0]![2] * unit) / m.width,
          (Math.max(...ys) - Math.min(...ys)) / 2 + (points[0]![2] * unit) / m.height,
        ];
        return commitNew(edited().add(d.base, shape, shapeCenter(shape), extent));
      }
      case 'node':
        return;
      case 'move':
        if (!d.moved) return;
        return onCommit(
          updateShape(d.base, d.id, roundShape(translateShape(d.shape, p[0] - d.start[0], p[1] - d.start[1]))),
          `${title()}: ${edited().noun} moved`,
        );
      case 'source':
        if (!d.moved) return;
        return onCommit(
          edited().setSource(d.base, d.index, [
            round(d.source[0] + p[0] - d.start[0]),
            round(d.source[1] + p[1] - d.start[1]),
          ]),
          `${title()}: source moved`,
        );
      case 'handle': {
        if (!d.moved) return;
        const words = { rx: 'resized', ry: 'resized', rotate: 'rotated', feather: 'feather' } as const;
        const word = typeof d.handle === 'object' ? 'path edited' : words[d.handle];
        return onCommit(
          updateShape(d.base, d.id, withHandle(d.shape, d.handle, p, d.free)),
          `${title()}: ${edited().noun} ${word}`,
        );
      }
    }
  };

  // ── Keyboard ──
  useEffect(() => {
    if (latest.current.readOnly) return;
    const down = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      const { ui, params, onUi, onCommit } = latest.current;
      const t = target(ui);
      const selected = ui.selected !== null && ui.selected < t.items(params).length ? ui.selected : null;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (ui.tool === 'path' && mod && (key === 'z' || key === 'y')) {
        // Within the path tool, undo and redo are its nodes'; with none left, undo leaves it.
        const nodes = draftRef.current ?? [];
        if (key === 'y' || e.shiftKey) {
          const node = undone.current.pop();
          if (node) setDraft([...nodes, node]);
        } else if (nodes.length) {
          undone.current.push(nodes.at(-1)!);
          setDraft(nodes.length > 1 ? nodes.slice(0, -1) : null);
        } else onUi({ tool: 'select' });
      } else if (e.key === 'Escape') {
        // A path being drawn is kept, as with Enter (it may have taken a while); one too
        // short for a shape is dropped with the tool.
        if (draftRef.current) {
          if (draftRef.current.length >= 3) closePath();
          else {
            setDraft(null);
            undone.current = [];
            onUi({ tool: 'select' });
          }
        } else if (ui.tool !== 'select') onUi({ tool: 'select' });
        else if (selected !== null) onUi({ selected: null });
        else onUi({ editing: false });
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected !== null) {
        onCommit(t.remove(params, selected), `${title()}: ${t.noun} removed`);
        onUi({ selected: null });
      } else if (e.key === 'Enter' && draftRef.current) {
        closePath();
      } else return;
      e.preventDefault();
      e.stopPropagation();
    };
    // In the capture phase: before the developer's shortcuts (Esc leaves it).
    window.addEventListener('keydown', down, true);
    return () => window.removeEventListener('keydown', down, true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A draft left when switching tools is dropped.
  useEffect(() => {
    if (ui.tool !== 'path') {
      setDraft(null);
      setHover(null);
      undone.current = [];
    }
  }, [ui.tool]);

  // ── Drawing ──

  const items = target(ui).items(params);
  const selected = ui.selected !== null && ui.selected < items.length ? ui.selected : null;
  const hit = HIT_PX / zoom;
  const handleR = HANDLE_PX / zoom;
  // With a tool, presses on the image draw: other shapes can't be selected or moved.
  const drawing = ui.tool !== 'select';
  const noPan = { 'data-no-pan': '' };

  const handleDot = (key: string, p: Point, onDown: (e: React.PointerEvent) => void, square = false) =>
    square ? (
      <rect
        key={key}
        {...noPan}
        x={p[0] - handleR}
        y={p[1] - handleR}
        width={2 * handleR}
        height={2 * handleR}
        fill="white"
        stroke={ORANGE}
        strokeWidth={1.5 / zoom}
        style={{ cursor: 'move', pointerEvents: drawing ? 'none' : 'all' }}
        onPointerDown={onDown}
      />
    ) : (
      <circle
        key={key}
        {...noPan}
        cx={p[0]}
        cy={p[1]}
        r={handleR}
        fill="white"
        stroke={ORANGE}
        strokeWidth={1.5 / zoom}
        style={{ cursor: 'grab', pointerEvents: drawing ? 'none' : 'all' }}
        onPointerDown={onDown}
      />
    );

  const handles = (id: string, shape: GeometricShape) => {
    if (shape.type === 'ellipse') {
      const [rx, ry] = shape.radii;
      const rxAt = onAxes(shape, rx, 0);
      return [
        <line
          key="arm"
          x1={disp(rxAt)[0]}
          y1={disp(rxAt)[1]}
          x2={beyond(shape.center, rxAt, 18)[0]}
          y2={beyond(shape.center, rxAt, 18)[1]}
          stroke={ORANGE}
          strokeWidth={1 / zoom}
        />,
        handleDot('rx', disp(rxAt), startHandle(id, shape, 'rx')),
        handleDot('ry', disp(onAxes(shape, 0, ry)), startHandle(id, shape, 'ry')),
        handleDot('rotate', beyond(shape.center, rxAt, 18), startHandle(id, shape, 'rotate')),
        handleDot('feather', disp(onAxes(shape, -(rx + shape.feather), 0)), startHandle(id, shape, 'feather')),
      ];
    }
    if (shape.type === 'gradient') {
      const [s, c] = [Math.sin(shape.angle), Math.cos(shape.angle)];
      const ahead = (d: number): Point => [
        shape.anchor[0] + (d * c * unit) / m.width,
        shape.anchor[1] + (d * s * unit) / m.height,
      ];
      return [
        handleDot('rotate', beyond(shape.anchor, ahead(0.01), 30), startHandle(id, shape, 'rotate')),
        handleDot('feather', disp(ahead(Math.max(shape.feather / 2, 0.002))), startHandle(id, shape, 'feather')),
      ];
    }
    if (shape.type === 'path') {
      return shape.points.flatMap((n, i) => {
        const node = disp([n[0], n[1]]);
        const inn = disp([n[2], n[3]]);
        const out = disp([n[4], n[5]]);
        const arm = (key: string, q: Point) => (
          <line key={key} x1={node[0]} y1={node[1]} x2={q[0]} y2={q[1]} stroke={ORANGE} strokeWidth={1 / zoom} />
        );
        return [
          arm(`in-arm${i}`, inn),
          arm(`out-arm${i}`, out),
          handleDot(`in${i}`, inn, startHandle(id, shape, { node: i, part: 'in' })),
          handleDot(`out${i}`, out, startHandle(id, shape, { node: i, part: 'out' })),
          handleDot(`at${i}`, node, startHandle(id, shape, { node: i, part: 'at' }), true),
        ];
      });
    }
    return [];
  };

  /** A visible outline: a dark halo under a light (or orange) line. */
  const outline = (key: string, d: string, color: string, dashed = false) => (
    <g key={key} style={{ pointerEvents: 'none' }}>
      <path d={d} fill="none" stroke="rgba(0,0,0,.55)" strokeWidth={3 / zoom} />
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={1.5 / zoom}
        strokeDasharray={dashed ? `${4 / zoom} ${3 / zoom}` : undefined}
      />
    </g>
  );

  const drawItem = (item: Item, index: number) => {
    const shape = params.shapes?.[item.shape];
    // Raster shapes (other instances' masks) have no outline.
    if (!shape || isRasterShape(shape)) return null;
    const isSelected = index === selected;
    const color = isSelected ? ORANGE : 'white';
    const o = shapeOutline(shape, sensor);
    const edges = o.edge.map((l) => line(l, o.closed));
    const sourceShape = item.source ? translateShape(shape, item.source[0], item.source[1]) : null;
    const so = sourceShape && shapeOutline(sourceShape, sensor);
    const brushWidth =
      shape.type === 'brush' && shape.points.length
        ? 2 * shape.points[0]![2] * displayScale(m, [shape.points[0]![0], shape.points[0]![1]], width, height)
        : 0;
    const catcher = (d: string, onDown: (e: React.PointerEvent) => void, cursor: string, stroke = hit) => (
      <path
        {...noPan}
        d={d}
        fill={o.closed ? 'transparent' : 'none'}
        stroke="transparent"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ pointerEvents: drawing ? 'none' : o.closed ? 'all' : 'stroke', cursor }}
        onPointerDown={onDown}
      />
    );
    return (
      <g key={index}>
        {so && sourceShape && (
          <>
            <line
              x1={disp(shapeCenter(shape))[0]}
              y1={disp(shapeCenter(shape))[1]}
              x2={disp(shapeCenter(sourceShape))[0]}
              y2={disp(shapeCenter(sourceShape))[1]}
              stroke={color}
              strokeOpacity={0.7}
              strokeWidth={1 / zoom}
              strokeDasharray={`${2 / zoom} ${3 / zoom}`}
              style={{ pointerEvents: 'none' }}
            />
            {brushWidth > 0 && (
              <path
                d={line(so.edge[0]!, false)}
                fill="none"
                stroke={color}
                strokeOpacity={0.12}
                strokeWidth={brushWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ pointerEvents: 'none' }}
              />
            )}
            {so.edge.map((l, i) => outline(`source${i}`, line(l, so.closed), color, true))}
            {so.edge.map((l, i) => (
              <g key={`source-hit${i}`}>
                {catcher(line(l, so.closed), startSource(index, item.source!), 'move', Math.max(hit, brushWidth))}
              </g>
            ))}
          </>
        )}
        {brushWidth > 0 && (
          <path
            d={edges[0]}
            fill="none"
            stroke={color}
            strokeOpacity={0.25}
            strokeWidth={brushWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ pointerEvents: 'none' }}
          />
        )}
        {edges.map((d, i) => outline(`edge${i}`, d, color))}
        {o.feather.map((l, i) => outline(`feather${i}`, line(l, o.closed), color, true))}
        {edges.map((d, i) => (
          <g key={`hit${i}`}>{catcher(d, startMove(index, item.shape, shape), 'move', Math.max(hit, brushWidth))}</g>
        ))}
        {isSelected && handles(item.shape, shape)}
      </g>
    );
  };

  // The path draft: its segments solid, and finely dashed what a click would add (to the
  // pointer, then back to the first node), or the closing segment.
  const nodes = draft ?? [];
  const solid =
    nodes.length > 1
      ? line([...flattenPath(nodes).slice(0, 16 * (nodes.length - 1)), nodeAt(nodes.at(-1)!)], false)
      : null;
  const first = nodes[0];
  // Over the first node (three nodes or more), a click closes the path: the pointer snaps to it.
  const closing =
    !!hover && !!first && nodes.length >= 3 && distance(disp(nodeAt(first)), disp(hover)) * zoom <= CLOSE_PX;
  const next =
    hover && !closing ? [...nodes, [hover[0], hover[1], hover[0], hover[1], hover[0], hover[1]] as PathNode] : nodes;
  const preview =
    next.length > 1 ? line([...flattenPath(next).slice(16 * (nodes.length - 1)), nodeAt(next[0]!)], false) : null;
  const showBar = ui.tool === 'path' && !props.readOnly && props.bar;

  return (
    <svg
      ref={svg}
      {...(ui.tool !== 'select' && !props.readOnly ? noPan : {})}
      viewBox={`0 0 ${width} ${height}`}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        // Shapes may reach past the image (the image's window clips them).
        overflow: 'visible',
        pointerEvents: ui.tool === 'select' || props.readOnly ? 'none' : 'all',
        cursor: ui.tool === 'select' || props.readOnly ? undefined : 'crosshair',
        touchAction: 'none',
      }}
      onPointerDown={onRootDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onPointerLeave={() => setHover(null)}
    >
      {/* With a tool, the area around the image takes presses too: a path's nodes, a
          gradient's start, a shape's centre may be outside it. */}
      {drawing && !props.readOnly && (
        <rect
          x={-10 * width}
          y={-10 * height}
          width={21 * width}
          height={21 * height}
          fill="transparent"
          style={{ pointerEvents: 'all' }}
        />
      )}
      {items.map(drawItem)}
      {draft && (
        <g style={{ pointerEvents: 'none' }}>
          {preview && (
            <g data-path-preview="">
              {[
                ['rgba(0,0,0,.55)', 2.5],
                [ORANGE, 1.25],
              ].map(([color, width]) => (
                <path
                  key={color}
                  d={preview}
                  fill="none"
                  stroke={color as string}
                  strokeWidth={(width as number) / zoom}
                  strokeDasharray={`${3 / zoom} ${3 / zoom}`}
                />
              ))}
            </g>
          )}
          {/* Where a click puts the next node. */}
          {hover && !closing && (
            <rect
              x={disp(hover)[0] - handleR}
              y={disp(hover)[1] - handleR}
              width={2 * handleR}
              height={2 * handleR}
              fill="none"
              stroke={ORANGE}
              strokeWidth={1 / zoom}
              strokeDasharray={`${2 / zoom} ${2 / zoom}`}
            />
          )}
          {solid && outline('draft', solid, ORANGE)}
          {draft.map((n, i) => {
            const p = disp([n[0], n[1]]);
            return (
              <rect
                key={i}
                x={p[0] - handleR}
                y={p[1] - handleR}
                width={2 * handleR}
                height={2 * handleR}
                fill={i === 0 ? ORANGE : 'white'}
                stroke={i === 0 && closing ? 'white' : ORANGE}
                strokeWidth={(i === 0 && closing ? 3 : 1.5) / zoom}
              />
            );
          })}
        </g>
      )}
      {showBar &&
        createPortal(
          <PathBar
            nodes={nodes.length}
            onCancel={() => {
              setDraft(null);
              undone.current = [];
              latest.current.onUi({ tool: 'select' });
            }}
            onApply={closePath}
          />,
          props.bar!,
        )}
    </svg>
  );
}

const nodeAt = (n: PathNode): Point => [n[0], n[1]];
const stop = (e: React.SyntheticEvent) => e.stopPropagation();
const distance = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * What the path tool says and does below the image, like the crop's: Apply closes the
 * path (three nodes at least), Cancel drops it; both leave the tool.
 */
function PathBar({ nodes, onCancel, onApply }: { nodes: number; onCancel: () => void; onApply: () => void }) {
  const hint =
    nodes === 0
      ? 'Click to place the first node, drag for a curve'
      : nodes < 3
        ? 'Click to add nodes, drag for curves'
        : 'Click the first node, Enter or Apply to close';
  return (
    <HStack
      bg="bg.panel"
      p="2"
      borderRadius="md"
      boxShadow="lg"
      data-path-bar=""
      // Portalled from the overlay: React would pass its pointer events on to it, and a
      // press on Apply would add a node under the button.
      onPointerDown={stop}
      onPointerMove={stop}
      onPointerUp={stop}
    >
      <Text textStyle="xs" color="fg.muted" px="2">
        {hint}
      </Text>
      <Button size="xs" variant="ghost" onClick={onCancel}>
        <X /> Cancel
      </Button>
      <Button
        size="xs"
        colorPalette="orange"
        disabled={nodes < 3}
        title={nodes < 3 ? 'A path needs three nodes' : 'Close the path and apply it'}
        onClick={onApply}
      >
        <Check /> Apply
      </Button>
    </HStack>
  );
}

function roundShape(shape: GeometricShape): GeometricShape {
  switch (shape.type) {
    case 'ellipse':
      return { ...shape, center: r6(shape.center) };
    case 'gradient':
      return { ...shape, anchor: r6(shape.anchor) };
    case 'path':
      return { ...shape, points: shape.points.map((n) => n.map(round) as PathNode) };
    case 'brush':
      return { ...shape, points: shape.points.map(([x, y, r, h]) => [round(x), round(y), r, h] as BrushPoint) };
  }
}
