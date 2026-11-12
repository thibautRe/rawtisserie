import { Badge, Box, Center, Circle, HStack, Image, Spinner, Stack, Text } from '@chakra-ui/react';
import { Check, CircleAlert, Star, X } from 'lucide-react';
import { memo } from 'react';
import type { Photo } from '../api/types.ts';
import { LABEL_COLORS } from './FilterSidebar.tsx';

/** The box behind a photo, highlighted with its other versions on hover. */
export const GROUP_BOX_CLASS = 'photo-group-box';

/** The grid's gap, in px. */
export const GRID_GAP = 8;

interface Props {
  photo: Photo;
  selected: boolean;
  focused: boolean;
  /** The photo's other versions are next to it on the same row: its box joins theirs. */
  joinLeft: boolean;
  joinRight: boolean;
  onClick: (e: React.MouseEvent, photo: Photo) => void;
  onOpen: (photo: Photo) => void;
  /** The pointer entered (a photo id) or left (null) one of the photo's versions. */
  onHover: (photoId: string | null) => void;
}

export const PhotoCard = memo(function PhotoCard({
  photo,
  selected,
  focused,
  joinLeft,
  joinRight,
  onClick,
  onOpen,
  onHover,
}: Props) {
  const rejected = photo.flag === 'rejected';
  const showBar = photo.rating > 0 || photo.flag || photo.colorLabel || photo.edited;
  return (
    <Box
      data-photo-id={photo.id}
      position="relative"
      aspectRatio="1"
      cursor="pointer"
      userSelect="none"
      onClick={(e) => onClick(e, photo)}
      onDoubleClick={() => onOpen(photo)}
      data-group={photo.photoId}
      onPointerEnter={() => onHover(photo.photoId)}
      onPointerLeave={() => onHover(null)}
    >
      {/* The box shared by the photo's versions, across the gap to the next one. The grid
          highlights a hovered photo's boxes with a style rule (`PhotoGrid`). */}
      <Box
        className={GROUP_BOX_CLASS}
        position="absolute"
        inset="0"
        right={joinRight ? `-${GRID_GAP}px` : '0'}
        bg="bg.panel"
        transition="background-color 0.2s"
        borderLeftRadius={joinLeft ? '0' : 'md'}
        borderRightRadius={joinRight ? '0' : 'md'}
      />
      <Box
        position="absolute"
        inset="0"
        bg={selected ? 'bg.emphasized' : undefined}
        borderRadius="md"
        borderWidth="2px"
        borderColor={selected ? 'orange.solid' : focused ? 'border.emphasized' : 'transparent'}
        overflow="hidden"
      >
        <Center position="absolute" inset="2" opacity={rejected ? 0.35 : 1}>
          {photo.thumbUrl ? (
            <Image
              src={photo.thumbUrl}
              alt={photo.title ?? photo.filename}
              maxW="full"
              maxH="full"
              objectFit="contain"
              loading="lazy"
              draggable={false}
              boxShadow="md"
            />
          ) : photo.renderStatus === 'failed' ? (
            <Stack align="center" color="fg.error" title={photo.renderError ?? undefined}>
              <CircleAlert />
              <Text textStyle="xs">Can't develop</Text>
            </Stack>
          ) : (
            <Spinner color="orange.solid" />
          )}
        </Center>

        {photo.renderStatus === 'pending' && photo.thumbUrl && (
          <Spinner size="xs" position="absolute" top="2" right="2" color="orange.solid" />
        )}

        {showBar && (
          <HStack position="absolute" insetX="0" bottom="0" px="2" py="1" gap="1" bg="blackAlpha.600" color="white">
            <HStack gap="0" color="orange.300">
              {Array.from({ length: photo.rating }, (_, i) => (
                <Star key={i} size={12} fill="currentColor" />
              ))}
            </HStack>
            <Box flex="1" />
            {photo.edited && (
              <Badge size="xs" bg="blackAlpha.700" color="white">
                edited
              </Badge>
            )}
            {photo.colorLabel && <Circle size="2.5" bg={LABEL_COLORS[photo.colorLabel]} />}
            {photo.flag === 'picked' && <Check size={14} />}
            {photo.flag === 'rejected' && <X size={14} color="var(--chakra-colors-red-400)" />}
          </HStack>
        )}
      </Box>
    </Box>
  );
});
