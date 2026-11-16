import { useSyncExternalStore } from 'react';

/**
 * Phones (roadmap 10.1): narrower than Chakra's `md` breakpoint (48em, 768 px). Below it
 * the library's side panels become drawers, a tap opens the loupe rather than selecting,
 * and the developer isn't offered (10.2). Layout alone goes in responsive style props;
 * this is for what changes behaviour or structure.
 */
export const NARROW_QUERY = '(max-width: 47.99em)';

const subscribe = (onChange: () => void) => {
  const query = window.matchMedia(NARROW_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};

export function useNarrow(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(NARROW_QUERY).matches);
}
