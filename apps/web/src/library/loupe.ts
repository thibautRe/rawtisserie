/**
 * The culling loupe's pure parts: which photos it walks through, and which tiles of a
 * zoomed-in view to load. `Loupe.tsx` puts them on the page.
 */
import type { BulkPatch, Photo, ZoomInfo } from '@rawtisserie/api';
import type { ZoomLayout, ZoomView } from '../develop/zoom.ts';
import { visibleRegion } from '../develop/zoom.ts';

/**
 * The loupe's list: the photos listed when it opened, in that order, then any loaded
 * since (the next pages). Photos rated out of the library's filters stay until it closes.
 */
export function loupeOrder(opened: string[], listed: Photo[]): string[] {
  const known = new Set(opened);
  const added = listed.filter((p) => !known.has(p.id)).map((p) => p.id);
  return added.length ? [...opened, ...added] : opened;
}

/** Whether a culling change moves the loupe on (with auto-advance): ratings and flags, not labels. */
export const advancesOn = (patch: BulkPatch) => patch.rating !== undefined || patch.flag !== undefined;

/**
 * The zoom level whose tiles to show at `scale` (device pixels per full-resolution
 * pixel): the coarsest one at least that fine. Null if the preview (`previewWidth`
 * pixels wide) is fine enough.
 */
export function tileLevel(info: ZoomInfo, scale: number, previewWidth: number): number | null {
  const full = info.levels[0]!.width;
  const need = Math.min(scale, 1) * 0.999;
  if (previewWidth / full >= need) return null;
  let level = 0;
  info.levels.forEach((l, i) => {
    if (l.width / full >= need) level = i;
  });
  return level;
}

export interface Tile {
  level: number;
  col: number;
  row: number;
  /** Where it goes, as fractions of the image. */
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The tiles of `level` that cover the visible part of the view, and a margin of half a
 * tile around it (for small pans), nearest the centre first.
 */
export function visibleTiles(info: ZoomInfo, level: number, layout: ZoomLayout, view: ZoomView): Tile[] {
  const visible = visibleRegion(layout, view);
  const size = info.levels[level];
  if (!visible || !size) return [];
  const t = info.tileSize;
  const f = size.width / visible.width;
  const r = visible.region;
  const margin = t / 2;
  const range = (start: number, length: number, total: number) => [
    Math.max(0, Math.floor((start * f - margin) / t)),
    Math.min(Math.ceil(total / t) - 1, Math.floor(((start + length) * f + margin) / t)),
  ];
  const [c0, c1] = range(r.x, r.width, size.width);
  const [r0, r1] = range(r.y, r.height, size.height);
  const cx = (r.x + r.width / 2) * f;
  const cy = (r.y + r.height / 2) * f;
  const tiles: (Tile & { d: number })[] = [];
  for (let row = r0!; row <= r1!; row++) {
    for (let col = c0!; col <= c1!; col++) {
      const x = col * t;
      const y = row * t;
      const w = Math.min(t, size.width - x);
      const h = Math.min(t, size.height - y);
      tiles.push({
        level,
        col,
        row,
        left: x / size.width,
        top: y / size.height,
        width: w / size.width,
        height: h / size.height,
        d: Math.hypot(x + w / 2 - cx, y + h / 2 - cy),
      });
    }
  }
  return tiles.sort((a, b) => a.d - b.d).map(({ d: _, ...tile }) => tile);
}

export const tileUrl = (versionId: string, info: ZoomInfo, tile: Pick<Tile, 'level' | 'col' | 'row'>) =>
  `/api/versions/${versionId}/zoom/${tile.level}/${tile.col}/${tile.row}?k=${info.key}`;
