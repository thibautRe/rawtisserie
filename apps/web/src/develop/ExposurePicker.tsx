import type { Photo } from '@rawtisserie/api';
import type { PhotoRef } from '@rawtisserie/pipeline';
import { useCallback, useRef, useState } from 'react';
import { photoPickerStart } from '../library/libraryView.ts';
import { PhotoPicker } from '../library/PhotoPicker.tsx';

/**
 * Choosing the photo a multiple exposure blends in, from the library (`PhotoPicker`), as
 * a promise: `choose` opens the picker and resolves with what was chosen; `dialog` is to
 * be rendered. It starts on the library's filters, or else the collection of the photo
 * edited (`collectionId`).
 */
export function useExposurePicker(collectionId: string | null) {
  const [asking, setAsking] = useState<{ current: PhotoRef | null; start: string } | null>(null);
  const resolve = useRef<((picked: PhotoRef | null) => void) | null>(null);
  const collection = useRef(collectionId);
  collection.current = collectionId;
  const choose = useCallback((current: PhotoRef | null) => {
    resolve.current?.(null);
    setAsking({ current, start: photoPickerStart(collection.current) });
    return new Promise<PhotoRef | null>((r) => (resolve.current = r));
  }, []);
  const onClose = useCallback((photo: Photo | null) => {
    resolve.current?.(photo && { sha256: photo.sha256, name: photo.filename });
    resolve.current = null;
    setAsking(null);
  }, []);
  const current = asking?.current;
  const dialog = asking && (
    <PhotoPicker
      title="Blend in another photo"
      description="It’s blended in as it comes off the sensor, scaled to cover this one."
      start={asking.start}
      isCurrent={current ? (p) => p.sha256 === current.sha256 : undefined}
      confirm="Blend in"
      onClose={onClose}
    />
  );
  return { choose, dialog };
}

/**
 * Photos picked from files for the public developer's multiple exposures, by SHA-256:
 * they stay in this tab only.
 */
const localExposures = new Map<string, File>();

/** An exposure source for `localExposures`. */
export function localExposure(sha256: string): Promise<ArrayBuffer | null> {
  return localExposures.get(sha256)?.arrayBuffer() ?? Promise.resolve(null);
}

/** Ask for a photo file to blend in, and keep it in `localExposures`; null if none was picked. */
export function chooseLocalExposure(accept: string): Promise<PhotoRef | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('cancel', () => resolve(null));
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      void fileId(file).then((sha256) => {
        localExposures.set(sha256, file);
        resolve({ sha256, name: file.name });
      });
    });
    input.click();
  });
}

/** The file's SHA-256 (what the library would know it by), or a random id where it can't be computed (plain HTTP). */
async function fileId(file: File): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
    return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}
