import { Badge, Box, Center, Circle, HStack, Image, Spinner, Stack, Text } from '@chakra-ui/react';
import { Check, CircleAlert, Star, X } from 'lucide-react';
import { memo } from 'react';
import type { Photo } from '../api/types.ts';
import { LABEL_COLORS } from './FilterSidebar.tsx';

interface Props {
  photo: Photo;
  selected: boolean;
  focused: boolean;
  onClick: (e: React.MouseEvent, photo: Photo) => void;
  onOpen: (photo: Photo) => void;
}

export const PhotoCard = memo(function PhotoCard({ photo, selected, focused, onClick, onOpen }: Props) {
  const rejected = photo.flag === 'rejected';
  return (
    <Box
      data-photo-id={photo.id}
      position="relative"
      aspectRatio="1"
      bg={selected ? 'bg.emphasized' : 'bg.muted'}
      borderRadius="md"
      borderWidth="2px"
      borderColor={selected ? 'orange.solid' : focused ? 'border.emphasized' : 'transparent'}
      cursor="pointer"
      userSelect="none"
      onClick={(e) => onClick(e, photo)}
      onDoubleClick={() => onOpen(photo)}
      className="group"
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

      <HStack
        position="absolute"
        insetX="0"
        bottom="0"
        px="2"
        py="1"
        gap="1"
        bgGradient="to-t"
        gradientFrom="blackAlpha.700"
        gradientTo="transparent"
        color="white"
        opacity={selected || photo.rating > 0 || photo.flag || photo.colorLabel ? 1 : 0}
        _groupHover={{ opacity: 1 }}
        transition="opacity 0.15s"
      >
        <HStack gap="0" color="orange.300">
          {Array.from({ length: photo.rating }, (_, i) => (
            <Star key={i} size={12} fill="currentColor" />
          ))}
        </HStack>
        <Box flex="1" />
        {photo.edited && (
          <Badge size="xs" variant="solid" colorPalette="orange">
            edited
          </Badge>
        )}
        {photo.colorLabel && <Circle size="2.5" bg={LABEL_COLORS[photo.colorLabel]} />}
        {photo.flag === 'picked' && <Check size={14} />}
        {photo.flag === 'rejected' && <X size={14} color="var(--chakra-colors-red-400)" />}
      </HStack>
    </Box>
  );
});
