import { Spinner, Stack, Text } from '@chakra-ui/react';
import { Check, CircleAlert, Star, X } from 'lucide-react';
import { memo } from 'react';
import type { Photo } from '../api/types.ts';
import { LABEL_COLORS } from './FilterSidebar.tsx';

import { GROUP_BOX_CLASS } from './photoCardCss.ts';
import { consumeLongPress, pressCancel, pressMove, pressStart, pressing } from './longPress.ts';

export { GRID_GAP, GROUP_BOX_CLASS } from './photoCardCss.ts';

interface Props {
  photo: Photo;
  selected: boolean;
  focused: boolean;
  /** The photo's other versions are next to it on the same row: its box joins theirs. */
  joinLeft: boolean;
  joinRight: boolean;
  onClick: (e: React.MouseEvent, photo: Photo) => void;
  onOpen?: (photo: Photo) => void;
  /** Held down (phones: selects; the click after it is swallowed). */
  onLongPress?: (photo: Photo) => void;
  /** The pointer entered (a photo id) or left (null) one of the photo's versions. */
  onHover: (photoId: string | null) => void;
}

/** A colour token as its CSS variable (`red.500` → `var(--chakra-colors-red-500)`). */
const colorVar = (token: string) => `var(--chakra-colors-${token.replace('.', '-')})`;

/**
 * A photo in the library's grid. Plain elements styled by `PHOTO_CARD_CSS` (see there:
 * style props cost too much here), with Chakra components only for what's rare.
 */
export const PhotoCard = memo(function PhotoCard({
  photo,
  selected,
  focused,
  joinLeft,
  joinRight,
  onClick,
  onOpen,
  onLongPress,
  onHover,
}: Props) {
  const showBar = photo.rating > 0 || photo.flag || photo.colorLabel || photo.edited;
  return (
    <div
      className="photo-card"
      data-photo-id={photo.id}
      data-group={photo.photoId}
      data-selected={selected || undefined}
      data-focused={focused || undefined}
      data-join-left={joinLeft || undefined}
      data-join-right={joinRight || undefined}
      data-rejected={photo.flag === 'rejected' || undefined}
      onClick={(e) => !consumeLongPress() && onClick(e, photo)}
      onDoubleClick={onOpen && (() => onOpen(photo))}
      onPointerDown={onLongPress && ((e) => pressStart(e, () => onLongPress(photo)))}
      onPointerMove={onLongPress && pressMove}
      onPointerUp={onLongPress && pressCancel}
      onPointerCancel={onLongPress && pressCancel}
      onContextMenu={onLongPress && ((e) => pressing() && e.preventDefault())}
      onPointerEnter={() => onHover(photo.photoId)}
      onPointerLeave={() => onHover(null)}
    >
      {/* The box shared by the photo's versions, across the gap to the next one. The grid
          highlights a hovered photo's boxes with a style rule (`PhotoGrid`). */}
      <div className={GROUP_BOX_CLASS} />
      <div className="photo-card-frame">
        <div className="photo-card-thumb">
          {photo.thumbUrl ? (
            <img src={photo.thumbUrl} alt={photo.title ?? photo.filename} loading="lazy" draggable={false} />
          ) : photo.renderStatus === 'failed' ? (
            <Stack align="center" color="fg.error" title={photo.renderError ?? undefined}>
              <CircleAlert />
              <Text textStyle="xs">Can't develop</Text>
            </Stack>
          ) : (
            <Spinner color="orange.solid" />
          )}
        </div>

        {photo.renderStatus === 'pending' && photo.thumbUrl && (
          <Spinner size="xs" position="absolute" top="2" right="2" color="orange.solid" />
        )}

        {showBar && (
          <div className="photo-card-bar">
            <span className="stars">
              {Array.from({ length: photo.rating }, (_, i) => (
                <Star key={i} size={12} fill="currentColor" />
              ))}
            </span>
            {photo.edited && <span className="edited">edited</span>}
            {photo.colorLabel && (
              <span className="label" style={{ background: colorVar(LABEL_COLORS[photo.colorLabel] ?? 'gray.500') }} />
            )}
            {photo.flag === 'picked' && <Check size={14} />}
            {photo.flag === 'rejected' && <X size={14} color="var(--chakra-colors-red-400)" />}
          </div>
        )}
      </div>
    </div>
  );
});
