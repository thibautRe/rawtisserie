/**
 * Small renders of the image as a menu item would leave it (presets and styles): each
 * row shows one, with a spinner until it's there. They're rendered at final quality by
 * the backend's thumbnail developer, which keeps caches of its own, after the
 * interactive renders (the worker runs them when it has nothing else to do), and kept
 * here by recipe, so reopening a menu over the same recipe shows them at once.
 */
import { Box, Spinner } from '@chakra-ui/react';
import type { EditParams } from '@rawtisserie/pipeline';
import { createContext, memo, useContext, useEffect, useRef, useState } from 'react';
import type { RenderBackend } from './renderBackend.ts';

/** Largest side of a menu thumbnail, in CSS pixels. */
export const THUMBNAIL_SIZE = 42;
/** How many thumbnails are kept. */
const KEPT = 96;

export class ThumbnailCache {
  private entries = new Map<string, Promise<ImageBitmap>>();
  private readonly backend: RenderBackend;

  constructor(backend: RenderBackend) {
    this.backend = backend;
  }

  /** The image rendered with `recipe` within `size × size` device pixels. */
  get(recipe: EditParams, size: number): Promise<ImageBitmap> {
    const key = `${size} ${JSON.stringify(recipe)}`;
    let entry = this.entries.get(key);
    if (entry) {
      // Most recently used last.
      this.entries.delete(key);
    } else {
      entry = this.backend.thumbnail(recipe, size, size);
      // A failed one is tried again next time.
      entry.catch(() => this.entries.get(key) === entry && this.entries.delete(key));
    }
    this.entries.set(key, entry);
    while (this.entries.size > KEPT) {
      const [oldest, bitmap] = this.entries.entries().next().value!;
      this.entries.delete(oldest);
      bitmap.then(
        (b) => b.close(),
        () => {},
      );
    }
    return entry;
  }

  dispose() {
    for (const bitmap of this.entries.values())
      bitmap.then(
        (b) => b.close(),
        () => {},
      );
    this.entries.clear();
  }
}

/** The developer's thumbnail cache, if menus should show thumbnails. */
export const ThumbnailContext = createContext<ThumbnailCache | null>(null);

/** A thumbnail cache for `backend`'s photo, for as long as the component is mounted. */
export function useThumbnailCache(backend: RenderBackend): ThumbnailCache {
  const [cache] = useState(() => new ThumbnailCache(backend));
  useEffect(() => () => cache.dispose(), [cache]);
  return cache;
}

/**
 * The image as `recipe` (read once, when mounted) leaves it, fitted in a
 * `THUMBNAIL_SIZE` square. Menus mount their items when they open.
 */
export const MenuThumbnail = memo(function MenuThumbnail({ recipe }: { recipe: () => EditParams }) {
  const cache = useContext(ThumbnailContext);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<'loading' | 'done' | 'failed'>('loading');
  useEffect(() => {
    if (!cache) return;
    let live = true;
    const size = Math.round(THUMBNAIL_SIZE * Math.min(window.devicePixelRatio || 1, 3));
    cache.get(recipe(), size).then(
      (bitmap) => {
        const c = canvas.current;
        if (!live || !c) return;
        c.width = bitmap.width;
        c.height = bitmap.height;
        try {
          c.getContext('2d')?.drawImage(bitmap, 0, 0);
          setState('done');
        } catch {
          setState('failed'); // closed meanwhile (evicted)
        }
      },
      () => live && setState('failed'),
    );
    return () => {
      live = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once, on mount
  if (!cache) return null;
  return (
    <Box
      flexShrink={0}
      w={`${THUMBNAIL_SIZE}px`}
      h={`${THUMBNAIL_SIZE}px`}
      display="flex"
      alignItems="center"
      justifyContent="center"
    >
      {state === 'loading' && <Spinner size="xs" color="fg.subtle" />}
      <canvas
        ref={canvas}
        aria-hidden
        style={{
          display: state === 'done' ? 'block' : 'none',
          maxWidth: '100%',
          maxHeight: '100%',
          borderRadius: '2px',
        }}
      />
    </Box>
  );
});
