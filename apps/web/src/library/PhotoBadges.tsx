import { Check, Star, X } from 'lucide-react';
import type { Photo } from '@rawtisserie/api';
import { LABEL_COLORS } from './FilterSidebar.tsx';

/** A colour token as its CSS variable (`red.500` → `var(--chakra-colors-red-500)`). */
const colorVar = (token: string) => `var(--chakra-colors-${token.replace('.', '-')})`;

const ICONS = { md: { star: 12, flag: 14 }, sm: { star: 8, flag: 9 } } as const;

/**
 * A photo's rating, flag, colour label (and whether it's edited) as a bar along the bottom
 * of its thumbnail, centred so a column of photos reads at a glance: the library's grid
 * (`md`) and the film roll (`sm`). Plain elements styled by `PHOTO_CARD_CSS`
 * (`.photo-badges`), as the grid's cards are. Nothing when there's nothing to show.
 */
export function PhotoBadges({
  photo,
  size = 'md',
  edited = false,
}: {
  photo: Pick<Photo, 'rating' | 'flag' | 'colorLabel' | 'edited'>;
  size?: 'md' | 'sm';
  /** Says so when the photo has edits. */
  edited?: boolean;
}) {
  const showEdited = edited && photo.edited;
  if (!(photo.rating > 0 || photo.flag || photo.colorLabel || showEdited)) return null;
  const icons = ICONS[size];
  return (
    <div className="photo-badges" data-size={size}>
      {photo.rating > 0 && (
        <span className="stars" aria-label={`${photo.rating} star${photo.rating > 1 ? 's' : ''}`}>
          {Array.from({ length: photo.rating }, (_, i) => (
            <Star key={i} size={icons.star} fill="currentColor" />
          ))}
        </span>
      )}
      {photo.flag === 'picked' && <Check size={icons.flag} aria-label="Picked" />}
      {photo.flag === 'rejected' && <X size={icons.flag} color="var(--chakra-colors-red-400)" aria-label="Rejected" />}
      {photo.colorLabel && (
        <span
          className="label"
          aria-label={`${photo.colorLabel} label`}
          style={{ background: colorVar(LABEL_COLORS[photo.colorLabel] ?? 'gray.500') }}
        />
      )}
      {showEdited && <span className="edited">edited</span>}
    </div>
  );
}
