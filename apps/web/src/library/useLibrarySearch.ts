import { useCallback, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';

/**
 * The filters as the address has them now. React Router hands updaters the params of
 * the last render, and renders navigations in a transition: a second change soon after
 * a first (two quick clicks) would start from before the first and undo it.
 */
const latest = (prev: URLSearchParams) =>
  typeof window === 'undefined' ? new URLSearchParams(prev) : new URLSearchParams(window.location.search);

/** How many filters `params` has: the flags shown count as one, and so do the imports, ratings and collections; the sort and how tags combine (`tagAny`) aren't filters. */
export function countFilters(params: URLSearchParams): number {
  return [...params.keys()].filter(
    (k, i, keys) =>
      k !== 'sort' &&
      k !== 'tagAny' &&
      (!['flag', 'import', 'rating', 'collection'].includes(k) || keys.indexOf(k) === i),
  ).length;
}

/**
 * Changes `next` as `change` does, given how a change is made (`next` starts from the
 * filters as they are now; `push` asks for an entry of its own in the browser's history).
 */
type Update = (change: (next: URLSearchParams) => void, options?: { push?: boolean }) => void;

/** The filters' operations, whatever keeps them (the address, or a component's state). */
function useSearchOps(params: URLSearchParams, update: Update, current: () => URLSearchParams) {
  const set = useCallback(
    (key: string, value: string | null | undefined) =>
      update((next) => {
        if (value === null || value === undefined || value === '') next.delete(key);
        else next.set(key, value);
      }),
    [update],
  );

  const toggle = useCallback(
    (key: string, value: string) =>
      update((next) => {
        const values = next.getAll(key);
        next.delete(key);
        for (const v of values.includes(value) ? values.filter((v) => v !== value) : [...values, value]) {
          next.append(key, v);
        }
      }),
    [update],
  );

  /** Replaces all of `key`'s values (none: removed). */
  const setAll = useCallback(
    (key: string, values: string[]) =>
      update((next) => {
        next.delete(key);
        for (const v of values) next.append(key, v);
      }),
    [update],
  );

  /** Every filter off; the sort stays. */
  const clear = useCallback(
    () =>
      update((next) => {
        for (const k of [...new Set(next.keys())]) if (k !== 'sort') next.delete(k);
      }),
    [update],
  );

  const activeFilterCount = countFilters(params);

  // The same object while the filters are: memoised panels take it.
  return useMemo(
    () => ({
      params,
      search: params.toString(),
      /** The filters as they are now, changes not rendered yet included. */
      current,
      set,
      setAll,
      toggle,
      /**
       * Changes several keys at once (none lost). In the address, replaces the history
       * entry, unless `push`: for a jump elsewhere (a link to a tag or a collection) that
       * Back should undo.
       */
      edit: update,
      clear,
      activeFilterCount,
    }),
    [params, current, set, setAll, toggle, update, clear, activeFilterCount],
  );
}

/**
 * Library filters live in the URL (shareable, survive reloads) and use the same
 * parameter names as `GET /api/versions`, so the query string is passed through as-is.
 */
export function useLibrarySearch() {
  const [params, setParams] = useSearchParams();
  const update = useCallback<Update>(
    (change, { push = false } = {}) =>
      setParams(
        (prev) => {
          const next = latest(prev);
          change(next);
          return next;
        },
        { replace: !push },
      ),
    [setParams],
  );
  const current = useCallback(() => latest(params), [params]);
  return useSearchOps(params, update, current);
}

/**
 * Filters like the library's, kept in the component's state rather than the address:
 * for a photo picker over the library (`PhotoPicker`), starting from `initial` (a query
 * string).
 */
export function useStateSearch(initial: string) {
  const [params, setParams] = useState(() => new URLSearchParams(initial));
  // What the changes made so far give, before they're rendered.
  const now = useRef(params);
  const update = useCallback<Update>((change) => {
    const next = new URLSearchParams(now.current);
    change(next);
    now.current = next;
    setParams(next);
  }, []);
  const current = useCallback(() => new URLSearchParams(now.current), []);
  return useSearchOps(params, update, current);
}

export type LibrarySearch = ReturnType<typeof useLibrarySearch>;
