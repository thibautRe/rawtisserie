import { Button, CloseButton, Dialog, Portal, Text } from '@chakra-ui/react';
import type { Photo } from '../api/types.ts';

type Version = Pick<Photo, 'id' | 'photoId' | 'versionCount'>;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What deleting these versions does. A photo goes away (original file included) once
 * all of its versions are deleted.
 */
export function describeDeletion(versions: Version[]) {
  const photos = new Map<string, { selected: number; count: number }>();
  for (const v of versions) {
    const p = photos.get(v.photoId) ?? { selected: 0, count: v.versionCount };
    photos.set(v.photoId, { ...p, selected: p.selected + 1 });
  }
  const removed = [...photos.values()].filter((p) => p.selected >= p.count).length;
  const n = versions.length;
  // Only single-version photos: this is deleting photos.
  if (removed === n) {
    return {
      title: `Delete ${plural(n, 'photo', 'photos')}?`,
      body: 'The original RAW files, edits and metadata will be permanently removed.',
      done: `Deleted ${plural(n, 'photo', 'photos')}`,
    };
  }
  const body = removed
    ? `This deletes every version of ${plural(removed, 'photo', 'photos')}: ` +
      `${removed === 1 ? 'its original RAW file' : 'their original RAW files'} will be permanently removed too.`
    : `The edit history and curation of ${n === 1 ? 'this version' : 'these versions'} will be removed. ` +
      'The original RAW files stay, with their other versions.';
  return {
    title: `Delete ${plural(n, 'version', 'versions')}?`,
    body,
    done: `Deleted ${plural(n, 'version', 'versions')}`,
  };
}

export function DeleteVersionsDialog<T extends Version>({
  versions,
  onConfirm,
  onClose,
}: {
  /** The versions to delete; the dialog is open while this is non-null. */
  versions: T[] | null;
  onConfirm: (versions: T[]) => void;
  onClose: () => void;
}) {
  const text = versions && describeDeletion(versions);
  return (
    <Dialog.Root open={!!versions} onOpenChange={(e) => !e.open && onClose()} role="alertdialog">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>{text?.title}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Text>{text?.body}</Text>
            </Dialog.Body>
            <Dialog.Footer>
              <Dialog.ActionTrigger asChild>
                <Button variant="outline">Cancel</Button>
              </Dialog.ActionTrigger>
              <Button colorPalette="red" onClick={() => versions && onConfirm(versions)} autoFocus>
                Delete
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
