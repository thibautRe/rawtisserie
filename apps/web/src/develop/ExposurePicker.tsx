import { Button, CloseButton, Dialog, Portal, Text } from '@chakra-ui/react';
import type { PhotoRef } from '@rawtisserie/pipeline';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLibraryPhotos } from '../api/hooks.ts';
import type { Photo } from '../api/types.ts';
import { FilmRoll as Roll } from '../library/FilmRoll.tsx';
import { savedLibraryView } from '../library/libraryView.ts';

/**
 * Pick the photo a multiple exposure blends in, from the library's photos as the film
 * roll shows them (the filters and sort the library was left with).
 */
function ExposurePicker({
  current,
  onClose,
}: {
  current: PhotoRef | null;
  /** The photo picked, or null. */
  onClose: (picked: PhotoRef | null) => void;
}) {
  const [search] = useState(() => savedLibraryView()?.search ?? '');
  const library = useLibraryPhotos(search);
  const { items, want } = library;
  useEffect(() => want(0, 0), [want]);
  const at = useMemo(() => items.findIndex((p) => !!current && p?.sha256 === current.sha256), [items, current]);
  const pick = useCallback((photo: Photo) => onClose({ sha256: photo.sha256, name: photo.filename }), [onClose]);
  return (
    <Dialog.Root open onOpenChange={(e) => !e.open && onClose(null)} size="xl">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Blend in another photo</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Text textStyle="sm" color="fg.muted" mb="3">
                The library’s photos, as you left its filters. It’s blended in as it comes off the sensor, scaled to
                cover this one.
              </Text>
              {library.total ? (
                <Roll items={items} current={at} onRange={want} onSelect={pick} />
              ) : (
                <Text textStyle="sm">No photos match the library’s filters.</Text>
              )}
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="outline" size="sm" onClick={() => onClose(null)}>
                Cancel
              </Button>
            </Dialog.Footer>
            <Dialog.CloseTrigger asChild>
              <CloseButton size="sm" />
            </Dialog.CloseTrigger>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

/**
 * `ExposurePicker` as a promise: `choose` opens it and resolves with what was picked;
 * `dialog` is to be rendered.
 */
export function useExposurePicker() {
  const [asking, setAsking] = useState<{ current: PhotoRef | null } | null>(null);
  const resolve = useRef<((picked: PhotoRef | null) => void) | null>(null);
  const choose = useCallback((current: PhotoRef | null) => {
    resolve.current?.(null);
    setAsking({ current });
    return new Promise<PhotoRef | null>((r) => (resolve.current = r));
  }, []);
  const onClose = useCallback((picked: PhotoRef | null) => {
    resolve.current?.(picked);
    resolve.current = null;
    setAsking(null);
  }, []);
  const dialog = asking && <ExposurePicker current={asking.current} onClose={onClose} />;
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
