import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Photo } from '../api/types.ts';
import { useStableCallback } from '../develop/useStableCallback.ts';

/**
 * Selecting in a photo grid (the library, the trash): a click selects one, Ctrl/Cmd+click
 * adds or removes one, Shift+click selects the range from the last one clicked. The
 * focused photo is the one the keyboard moves from.
 */
export function useGridSelection<T extends Photo>(
  /** One slot per photo listed, undefined until its page is in. */
  items: (T | undefined)[],
  initial: { selection: string[]; focusedId: string | null } = { selection: [], focusedId: null },
) {
  /** The photos whose pages are in, in order. */
  const photos = useMemo(() => items.filter((p) => p !== undefined), [items]);
  const [selection, setSelection] = useState<Set<string>>(() => new Set(initial.selection));
  const [focusedId, setFocusedId] = useState<string | null>(initial.focusedId);
  const anchorRef = useRef<string | null>(initial.focusedId);

  // Drop selected photos that are no longer listed (deleted / filtered out): those gone
  // from the pages that are in. (One whose page isn't in yet may still be listed.)
  const listedBefore = useRef(new Set<string>());
  useEffect(() => {
    const listed = new Set(photos.map((p) => p.id));
    const gone = [...listedBefore.current].filter((id) => !listed.has(id));
    listedBefore.current = listed;
    if (!gone.length) return;
    setSelection((sel) => {
      const kept = [...sel].filter((id) => !gone.includes(id));
      return kept.length === sel.size ? sel : new Set(kept);
    });
  }, [photos]);

  const focusedIndex = useMemo(() => items.findIndex((p) => p?.id === focusedId), [items, focusedId]);
  const selected = useMemo(() => photos.filter((p) => selection.has(p.id)), [photos, selection]);

  const selectOne = useCallback((id: string) => {
    setSelection(new Set([id]));
    setFocusedId(id);
    anchorRef.current = id;
  }, []);

  /** Select these, the last one focused (e.g. new duplicates). */
  const selectMany = useCallback((ids: string[]) => {
    setSelection(new Set(ids));
    const last = ids.at(-1) ?? null;
    setFocusedId(last);
    anchorRef.current = last;
  }, []);

  // Stable: the grid's cards are memoised, and would all render again when a page comes in.
  const onClick = useStableCallback((e: React.MouseEvent, photo: Photo) => {
    if (e.shiftKey && anchorRef.current) {
      const ids = photos.map((p) => p.id);
      const [a, b] = [ids.indexOf(anchorRef.current), ids.indexOf(photo.id)].sort((x, y) => x - y);
      setSelection(new Set(ids.slice(a, b! + 1)));
      setFocusedId(photo.id);
    } else if (e.metaKey || e.ctrlKey) {
      setSelection((sel) => {
        const next = new Set(sel);
        if (next.has(photo.id)) next.delete(photo.id);
        else next.add(photo.id);
        return next;
      });
      setFocusedId(photo.id);
      anchorRef.current = photo.id;
    } else {
      selectOne(photo.id);
    }
  });

  /**
   * Move the focus by `delta` positions (arrow keys), selecting the photo there, or with
   * `extend` adding it to the selection. Returns the position if its page isn't in yet.
   */
  const step = useCallback(
    (delta: number, extend: boolean): number | null => {
      const at = Math.min(items.length - 1, Math.max(0, focusedIndex < 0 ? 0 : focusedIndex + delta));
      const next = items[at];
      if (!next) return at;
      if (extend) {
        setSelection((sel) => new Set(sel).add(next.id));
        setFocusedId(next.id);
      } else selectOne(next.id);
      return null;
    },
    [items, focusedIndex, selectOne],
  );

  const selectAll = useCallback(() => setSelection(new Set(photos.map((p) => p.id))), [photos]);
  const clear = useCallback(() => setSelection(new Set()), []);

  return {
    photos,
    selection,
    selected,
    focusedId,
    focusedIndex,
    onClick,
    selectOne,
    selectMany,
    step,
    selectAll,
    clear,
  };
}
