/** What the trash's buttons, toasts and confirmations say. */
import type { Photo, TrashItem } from '../api/types.ts';

export type Version = Pick<Photo, 'id' | 'photoId' | 'versionCount'>;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "3 photos" when these are all of their photos' versions, else "3 versions". */
export function describeVersions(versions: Version[]) {
  const selected = new Map<string, number>();
  for (const v of versions) selected.set(v.photoId, (selected.get(v.photoId) ?? 0) + 1);
  const whole = versions.every((v) => selected.get(v.photoId)! >= v.versionCount);
  return plural(versions.length, whole ? 'photo' : 'version', whole ? 'photos' : 'versions');
}

/**
 * What deleting these from the trash does. `all` is what the trash lists: a photo's
 * original goes once none of its versions is left in the library or the trash.
 */
export function describeDeletion(selected: TrashItem[], all: TrashItem[]) {
  const ids = new Set(selected.map((v) => v.id));
  const photos = new Set(selected.filter((v) => v.photoInTrash).map((v) => v.photoId));
  const originals = [...photos].filter((p) => all.every((v) => v.photoId !== p || ids.has(v.id))).length;
  const n = selected.length;
  return {
    title: `Delete ${plural(n, 'item', 'items')} permanently?`,
    body:
      (originals
        ? `${plural(originals, 'original RAW file', 'original RAW files')} will be deleted, with ` +
          `${n === 1 ? 'its edits and metadata' : 'the edits and metadata'}. `
        : `The edit history and curation of ${n === 1 ? 'this version' : 'these versions'} will be deleted. ` +
          'Their original RAW files stay, with their other versions. ') + 'This can’t be undone.',
  };
}

const DAY = 86_400_000;

/** "in 12 days", "tomorrow", "today". */
export function deletedIn(deleteAt: string, now = Date.now()) {
  const days = Math.ceil((Date.parse(deleteAt) - now) / DAY);
  return days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
}
