import { useCallback, useLayoutEffect, useRef } from 'react';

/** A function that never changes identity and always calls the latest `fn`, for memoised children. */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R) {
  const latest = useRef(fn);
  useLayoutEffect(() => {
    latest.current = fn;
  });
  return useCallback((...args: A) => latest.current(...args), []);
}
