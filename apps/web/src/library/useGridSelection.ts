import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Photo, Target } from '@rawtisserie/api';
import { useStableCallback } from '../develop/useStableCallback.ts';
import { keptUnder } from '../api/hooks.ts';

/** Every photo a filter matches (roadmap 8.13), but those unticked since. */
interface AllMatching {
  /** The library's query string it was made for: another filter drops it. */
  scope: string;
  except: Set<string>;
}

/**
 * Selecting in a photo grid (the library, the trash): a click selects one, Ctrl/Cmd+click
 * adds or removes one, Shift+click selects the range from the last one clicked. The
 * focused photo is the one the keyboard moves from.
 *
 * With `scope` (the library's query string) and `total`, Select all (Ctrl+A) selects
 * every photo the filters match, loaded or not (roadmap 8.13): a selection by filter,
 * which `target` gives the server to resolve. Ctrl+click then unticks some; a plain click,
 * a range or another filter goes back to a selection of ids. Without them (the trash), it
 * selects the photos loaded.
 */
export function useGridSelection<T extends Photo>(
  /** One slot per photo listed, undefined until its page is in. */
  items: (T | undefined)[],
  initial: { selection: string[]; focusedId: string | null } = { selection: [], focusedId: null },
  { scope, total = items.length }: { scope?: string; total?: number } = {},
) {
  /** The photos whose pages are in, in order. */
  const photos = useMemo(() => items.filter((p) => p !== undefined), [items]);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(initial.selection));
  const [allMatching, setAllMatching] = useState<AllMatching | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(initial.focusedId);
  const anchorRef = useRef<string | null>(initial.focusedId);
  const all = allMatching && scope !== undefined && allMatching.scope === scope ? allMatching : null;
  // Another filter drops it for good: coming back to this one doesn't select them all again.
  useEffect(() => {
    if (allMatching && allMatching.scope !== scope) setAllMatching(null);
  }, [scope, allMatching]);

  // Drop selected photos that are no longer listed (deleted / filtered out): those gone
  // from the pages that are in. (One whose page isn't in yet may still be listed.)
  const listedBefore = useRef(new Set<string>());
  useEffect(() => {
    const listed = new Set(photos.map((p) => p.id));
    const gone = [...listedBefore.current].filter((id) => !listed.has(id));
    listedBefore.current = listed;
    if (!gone.length) return;
    setPicked((sel) => {
      const kept = [...sel].filter((id) => !gone.includes(id));
      return kept.length === sel.size ? sel : new Set(kept);
    });
  }, [photos]);

  /** The selected photos among those loaded (all of them but the unticked, selecting by filter). */
  const selection = useMemo(
    () => (all ? new Set(photos.filter((p) => !all.except.has(p.id)).map((p) => p.id)) : picked),
    [all, photos, picked],
  );
  /** How many are selected, loaded or not. */
  const count = all ? Math.max(0, total - all.except.size) : picked.size;

  const focusedIndex = useMemo(() => items.findIndex((p) => p?.id === focusedId), [items, focusedId]);
  const selected = useMemo(() => photos.filter((p) => selection.has(p.id)), [photos, selection]);

  const selectOne = useCallback((id: string) => {
    setAllMatching(null);
    setPicked(new Set([id]));
    setFocusedId(id);
    anchorRef.current = id;
  }, []);

  /** Select these, the last one focused (e.g. new duplicates). */
  const selectMany = useCallback((ids: string[]) => {
    setAllMatching(null);
    setPicked(new Set(ids));
    const last = ids.at(-1) ?? null;
    setFocusedId(last);
    anchorRef.current = last;
  }, []);

  /** Add the photo to the selection, or take it out (Ctrl+click, a long press on phones). */
  const toggle = useStableCallback((id: string) => {
    if (all) {
      const except = new Set(all.except);
      if (!except.delete(id)) except.add(id);
      setAllMatching({ ...all, except });
    } else
      setPicked((sel) => {
        const next = new Set(sel);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    setFocusedId(id);
    anchorRef.current = id;
  });

  // Stable: the grid's cards are memoised, and would all render again when a page comes in.
  const onClick = useStableCallback((e: React.MouseEvent, photo: Photo) => {
    if (e.shiftKey && anchorRef.current) {
      const ids = photos.map((p) => p.id);
      const [a, b] = [ids.indexOf(anchorRef.current), ids.indexOf(photo.id)].sort((x, y) => x - y);
      setAllMatching(null);
      setPicked(new Set(ids.slice(a, b! + 1)));
      setFocusedId(photo.id);
    } else if (e.metaKey || e.ctrlKey) {
      toggle(photo.id);
    } else {
      selectOne(photo.id);
    }
  });

  /**
   * Move the focus by `delta` positions (arrow keys), selecting the photo there, or with
   * `extend` (Shift) selecting the range from the anchor to it, as Shift+click does: going
   * back towards the anchor unselects. Returns the position if its page isn't in yet.
   */
  const step = useCallback(
    (delta: number, extend: boolean): number | null => {
      const at = Math.min(items.length - 1, Math.max(0, focusedIndex < 0 ? 0 : focusedIndex + delta));
      const next = items[at];
      if (!next) return at;
      if (!extend) {
        selectOne(next.id);
        return null;
      }
      if (all) {
        // Selecting by filter: everything is selected already, but those unticked.
        const except = new Set(all.except);
        except.delete(next.id);
        setAllMatching({ ...all, except });
      } else {
        if (!anchorRef.current && focusedId) anchorRef.current = focusedId;
        const anchor = items.findIndex((p) => p?.id === anchorRef.current);
        const [a, b] = anchor < 0 ? [at, at] : [Math.min(anchor, at), Math.max(anchor, at)];
        setPicked(new Set(items.slice(a, b + 1).flatMap((p) => (p ? [p.id] : []))));
        if (anchor < 0) anchorRef.current = next.id;
      }
      setFocusedId(next.id);
      return null;
    },
    [items, focusedIndex, focusedId, selectOne, all],
  );

  const selectAll = useCallback(() => {
    if (scope === undefined) return setPicked(new Set(photos.map((p) => p.id)));
    setPicked(new Set());
    setAllMatching({ scope, except: new Set() });
  }, [photos, scope]);
  const clear = useCallback(() => {
    setAllMatching(null);
    setPicked(new Set());
  }, []);

  /** What actions on the selection apply to, for the server. */
  const target = useCallback(
    (): Target =>
      all ? { filter: all.scope, except: [...all.except], ...keptUnder(all.scope) } : { ids: [...picked] },
    [all, picked],
  );

  return {
    photos,
    selection,
    selected,
    /** How many are selected, loaded or not. */
    count,
    /** Whether the selection is every photo the filters match (but those unticked). */
    allMatching: all !== null,
    target,
    focusedId,
    focusedIndex,
    onClick,
    toggle,
    selectOne,
    selectMany,
    step,
    selectAll,
    clear,
  };
}
