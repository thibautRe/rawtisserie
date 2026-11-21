import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';

/**
 * The filters as the address has them now. React Router hands updaters the params of
 * the last render, and renders navigations in a transition: a second change soon after
 * a first (two quick clicks) would start from before the first and undo it.
 */
const latest = (prev: URLSearchParams) =>
  typeof window === 'undefined' ? new URLSearchParams(prev) : new URLSearchParams(window.location.search);

/**
 * Library filters live in the URL (shareable, survive reloads) and use the same
 * parameter names as `GET /api/versions`, so the query string is passed through as-is.
 */
export function useLibrarySearch() {
  const [params, setParams] = useSearchParams();

  const set = useCallback(
    (key: string, value: string | null | undefined) =>
      setParams(
        (prev) => {
          const next = latest(prev);
          if (value === null || value === undefined || value === '') next.delete(key);
          else next.set(key, value);
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );

  const toggle = useCallback(
    (key: string, value: string) =>
      setParams(
        (prev) => {
          const next = latest(prev);
          const values = next.getAll(key);
          next.delete(key);
          for (const v of values.includes(value) ? values.filter((v) => v !== value) : [...values, value]) {
            next.append(key, v);
          }
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );

  /** Replaces all of `key`'s values (none: removed). */
  const setAll = useCallback(
    (key: string, values: string[]) =>
      setParams(
        (prev) => {
          const next = latest(prev);
          next.delete(key);
          for (const v of values) next.append(key, v);
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );

  /**
   * Changes several keys at once (none lost). Replaces the history entry, unless `push`:
   * for a jump elsewhere (a link to a tag or a collection) that Back should undo.
   */
  const edit = useCallback(
    (change: (next: URLSearchParams) => void, { push = false }: { push?: boolean } = {}) =>
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

  const clear = useCallback(
    () =>
      setParams(
        (prev) => {
          const sort = latest(prev).get('sort');
          return sort ? new URLSearchParams({ sort }) : new URLSearchParams();
        },
        { replace: true },
      ),
    [setParams],
  );

  // The flags shown count as one filter, and so do the imports and the ratings; how tags
  // combine (`tagAny`) isn't one.
  const activeFilterCount = [...params.keys()].filter(
    (k, i, keys) =>
      k !== 'sort' &&
      k !== 'tagAny' &&
      (!['flag', 'import', 'rating', 'collection'].includes(k) || keys.indexOf(k) === i),
  ).length;

  // The same object while the filters are: memoised panels take it.
  return useMemo(
    () => ({ params, search: params.toString(), set, setAll, toggle, edit, clear, activeFilterCount }),
    [params, set, setAll, toggle, edit, clear, activeFilterCount],
  );
}

export type LibrarySearch = ReturnType<typeof useLibrarySearch>;
