import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';

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
          const next = new URLSearchParams(prev);
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
          const next = new URLSearchParams(prev);
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
          const next = new URLSearchParams(prev);
          next.delete(key);
          for (const v of values) next.append(key, v);
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );

  const clear = useCallback(
    () =>
      setParams(
        (prev) => {
          const sort = prev.get('sort');
          return sort ? new URLSearchParams({ sort }) : new URLSearchParams();
        },
        { replace: true },
      ),
    [setParams],
  );

  // The flags shown count as one filter, and so do the imports.
  const activeFilterCount = [...params.keys()].filter(
    (k, i, keys) => k !== 'sort' && ((k !== 'flag' && k !== 'import') || keys.indexOf(k) === i),
  ).length;

  // The same object while the filters are: memoised panels take it.
  return useMemo(
    () => ({ params, search: params.toString(), set, setAll, toggle, clear, activeFilterCount }),
    [params, set, setAll, toggle, clear, activeFilterCount],
  );
}

export type LibrarySearch = ReturnType<typeof useLibrarySearch>;
