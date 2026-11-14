import { Box, Skeleton, Text } from '@chakra-ui/react';
import { memo } from 'react';
import type { ImportItem } from './imports.ts';

/**
 * A file still being imported, in the grid before the photos: a slow shimmer, its name,
 * and a thin bar while it uploads. It gives way to the photo once imported.
 */
export const PendingCard = memo(function PendingCard({ item }: { item: ImportItem }) {
  const uploading = item.status === 'uploading';
  return (
    <Box
      data-pending={item.key}
      position="relative"
      aspectRatio="1"
      borderRadius="md"
      overflow="hidden"
      title={uploading ? `Uploading ${item.name}` : `Waiting to upload ${item.name}`}
    >
      <Skeleton variant="shine" position="absolute" inset="0" borderRadius="md" css={{ '--duration': '2.5s' }} />
      <Text position="absolute" insetX="2" bottom="2.5" textStyle="2xs" color="fg.subtle" truncate fontFamily="numeric">
        {item.name}
      </Text>
      {uploading && (
        <Box position="absolute" insetX="0" bottom="0" h="2px" bg="bg.emphasized">
          <Box
            h="full"
            bg="orange.solid"
            w={`${item.size ? (100 * item.sent) / item.size : 0}%`}
            transition="width 0.3s"
          />
        </Box>
      )}
    </Box>
  );
});
