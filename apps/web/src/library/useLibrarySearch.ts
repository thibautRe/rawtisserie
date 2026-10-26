import { useCallback } from 'react';
import { useSearchParams } from 'react-router';

/**
 * Library filters live in the URL (shareable, survive reloads) and use the same
 * parameter names as `GET /api/photos`, so the query string is passed through as-is.
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

  const activeFilterCount = [...params.keys()].filter((k) => k !== 'sort').length;

  return { params, search: params.toString(), set, toggle, clear, activeFilterCount };
}

export type LibrarySearch = ReturnType<typeof useLibrarySearch>;
