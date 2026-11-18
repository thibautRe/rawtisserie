/**
 * Previews of presets and styles on one library photo, while the apply menu is open:
 * the photo is opened in the in-browser pipeline (as in the developer), and the
 * highlighted edit is rendered on top of its current recipe.
 */
import { type EditParams, type PhotoMetadata, denoiseKeyName, normalizeEditParams } from '@rawtisserie/pipeline';
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchDenoised, fetchOriginal } from '../api/originals.ts';
import type { PhotoDetail } from '../api/types.ts';
import { LocalRenderBackend } from '../develop/localRenderBackend.ts';
import type { BatchEdit } from './batchEdit.ts';
import { defaultRecipeFor, preloadLensfun } from '../develop/lensfun.ts';

/**
 * Open a photo for previewing. The one place that knows where the pixels come from:
 * the denoised photo kept for its recipe (raw denoise), else the original, for now; a
 * small proxy image once there are some. Previews don't denoise (no models: they're
 * small, where it shows least).
 */
async function openForPreview(backend: LocalRenderBackend, photo: Pick<PhotoDetail, 'originalUrl' | 'editParams'>) {
  const key = photo.editParams ? denoiseKeyName(normalizeEditParams(photo.editParams)) : null;
  const denoised = key && (await fetchDenoised(photo.originalUrl, key));
  const metadata = denoised
    ? await backend.loadDenoised(denoised)
    : await backend.load(await fetchOriginal(photo.originalUrl));
  // Without a recipe yet, previews start from the default one, which may use it.
  if (!photo.editParams) await preloadLensfun(metadata);
  return metadata;
}

/** The decoded photo goes (worker and memory) this long after the menu closes. */
const IDLE_MS = 2 * 60_000;
/** Moving between menu items briefly highlights none: wait before going back to the recipe. */
const UNHIGHLIGHT_MS = 120;
/** Rendered previews kept per photo, so going back to an item is instant. */
const CACHE_SIZE = 40;

export type PreviewStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface EditPreview {
  /** Draw previews here; shown over the photo's preview while `active`. */
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  status: PreviewStatus;
  /** The menu is open and a render has been drawn. */
  active: boolean;
  /** Something is being loaded or rendered. */
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onPreview: (edit: BatchEdit | null) => void;
}

/** `photo` is the detail (with its recipe); `width × height` the preview's size in CSS pixels. */
export function useEditPreview(photo: PhotoDetail | undefined, width: number, height: number): EditPreview {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<PreviewStatus>('idle');
  const [active, setActive] = useState(false);
  const [rendering, setRendering] = useState(false);

  const s = useRef({
    backend: null as LocalRenderBackend | null,
    /** Which file is loaded (versions of a photo share it), and its metadata once decoded. */
    loading: null as { photoId: string; done: Promise<PhotoMetadata> } | null,
    metadata: null as PhotoMetadata | null,
    open: false,
    /** What should be shown: an edit, or the recipe as it is (null). */
    wanted: null as BatchEdit | null,
    busy: false,
    cache: new Map<string, ImageBitmap>(),
    idleTimer: 0,
    unhighlightTimer: 0,
  }).current;
  const latest = useRef({ photo, width, height });
  latest.current = { photo, width, height };

  const clearCache = useCallback(() => {
    for (const b of s.cache.values()) b.close();
    s.cache.clear();
  }, [s]);

  const dispose = useCallback(() => {
    s.backend?.dispose();
    s.backend = null;
    s.loading = null;
    s.metadata = null;
    clearCache();
    setStatus('idle');
  }, [s, clearCache]);

  /** The recipe previews start from: the current entry, or what a new image starts with. */
  const baseRecipe = (detail: PhotoDetail, metadata: PhotoMetadata): EditParams =>
    detail.editParams ?? defaultRecipeFor(metadata);

  const draw = useCallback(
    (bitmap: ImageBitmap) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
      setActive(true);
    },
    [canvasRef],
  );

  /** Render what's wanted, latest wins: one render at a time, then the newest request. */
  const pump = useCallback(async () => {
    const { photo: detail, width: w, height: h } = latest.current;
    if (s.busy || !s.open || !s.backend || !s.metadata || !detail) return;
    const edit = s.wanted;
    const dpr = window.devicePixelRatio || 1;
    const key = `${detail.id}:${detail.revision}:${Math.round(w * dpr)}x${Math.round(h * dpr)}:${edit?.key ?? ''}`;
    const cached = s.cache.get(key);
    if (cached) return draw(cached);
    s.busy = true;
    setRendering(true);
    try {
      const base = baseRecipe(detail, s.metadata);
      const frame = await s.backend.render(edit ? edit.apply(base) : base, Math.round(w * dpr), Math.round(h * dpr));
      s.cache.set(key, frame.image);
      if (s.cache.size > CACHE_SIZE) {
        const [oldest] = s.cache.keys();
        s.cache.get(oldest!)!.close();
        s.cache.delete(oldest!);
      }
      if (s.open && s.wanted === edit) draw(frame.image);
    } catch {
      // A failed preview leaves the photo's own preview showing.
    } finally {
      s.busy = false;
      setRendering(false);
    }
    if (s.open && s.wanted !== edit) void pump();
  }, [s, draw]);

  const onOpenChange = useCallback(
    (open: boolean) => {
      s.open = open;
      window.clearTimeout(s.idleTimer);
      window.clearTimeout(s.unhighlightTimer);
      s.wanted = null;
      if (!open) {
        setActive(false);
        s.idleTimer = window.setTimeout(dispose, IDLE_MS);
        return;
      }
      const detail = latest.current.photo;
      if (!detail) return;
      if (s.loading?.photoId !== detail.photoId) {
        s.backend?.dispose();
        clearCache();
        s.backend = new LocalRenderBackend();
        s.metadata = null;
        const backend = s.backend;
        const loading = { photoId: detail.photoId, done: openForPreview(backend, detail) };
        s.loading = loading;
        setStatus('loading');
        loading.done.then(
          (metadata) => {
            if (s.loading !== loading) return;
            s.metadata = metadata;
            setStatus('ready');
            void pump();
          },
          () => {
            if (s.loading !== loading) return;
            dispose();
            setStatus('error');
          },
        );
      } else void pump();
    },
    [s, dispose, clearCache, pump],
  );

  const onPreview = useCallback(
    (edit: BatchEdit | null) => {
      window.clearTimeout(s.unhighlightTimer);
      if (edit) {
        s.wanted = edit;
        void pump();
      } else {
        s.unhighlightTimer = window.setTimeout(() => {
          s.wanted = null;
          void pump();
        }, UNHIGHLIGHT_MS);
      }
    },
    [s, pump],
  );

  // Another photo: let go of this one (it would only be reloaded if it's another version of it).
  const photoId = photo?.photoId;
  useEffect(
    () => () => {
      window.clearTimeout(s.idleTimer);
      window.clearTimeout(s.unhighlightTimer);
      s.open = false;
      setActive(false);
      dispose();
    },
    [photoId, s, dispose],
  );

  return { canvasRef, status, active, busy: status === 'loading' || rendering, onOpenChange, onPreview };
}
