import type { BulkPatch } from '../api/types.ts';
import { displayTag } from '../lib/tags.ts';

/** Selections larger than this ask before an action (roadmap 8.13). */
export const LARGE_SELECTION = 200;

/** `1 photo`, `1,240 photos`. */
export const photoCount = (n: number) => `${n.toLocaleString('en-US')} photo${n === 1 ? '' : 's'}`;

/** The question before a change to a large selection, and its button. */
export function patchQuestion(patch: BulkPatch, n: number): { title: string; confirm: string } {
  const photos = photoCount(n);
  const ask = (title: string, confirm: string) => ({ title: `${title}?`, confirm });
  if (patch.rating !== undefined)
    return patch.rating
      ? ask(`Rate ${photos} ${patch.rating} star${patch.rating === 1 ? '' : 's'}`, 'Rate')
      : ask(`Clear the rating of ${photos}`, 'Clear');
  if (patch.flag !== undefined)
    return patch.flag === 'picked'
      ? ask(`Pick ${photos}`, 'Pick')
      : patch.flag === 'rejected'
        ? ask(`Reject ${photos}`, 'Reject')
        : ask(`Unflag ${photos}`, 'Unflag');
  if (patch.colorLabel !== undefined)
    return patch.colorLabel
      ? ask(`Label ${photos} ${patch.colorLabel}`, 'Label')
      : ask(`Remove the label from ${photos}`, 'Remove');
  if (patch.addTags?.length) return ask(`Tag ${photos} ${patch.addTags.map(displayTag).join(', ')}`, 'Tag');
  if (patch.removeTags?.length)
    return ask(`Remove ${patch.removeTags.map(displayTag).join(', ')} from ${photos}`, 'Remove');
  return ask(`Change ${photos}`, 'Change');
}
