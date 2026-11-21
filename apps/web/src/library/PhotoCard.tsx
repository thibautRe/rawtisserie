import { Spinner, Stack, Text } from '@chakra-ui/react';
import { CircleAlert } from 'lucide-react';
import { memo } from 'react';
import type { Photo } from '@rawtisserie/api';
import { PhotoBadges } from './PhotoBadges.tsx';

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

        <PhotoBadges photo={photo} edited />
      </div>
    </div>
  );
});
