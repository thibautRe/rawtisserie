import { Box, Center, Grid, Spinner } from '@chakra-ui/react';
import { forwardRef, useEffect, useRef } from 'react';
import type { Photo } from '../api/types.ts';
import { PhotoCard } from './PhotoCard.tsx';

interface Props {
  photos: Photo[];
  selection: Set<string>;
  focusedId: string | null;
  cellSize: number;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onClick: (e: React.MouseEvent, photo: Photo) => void;
  onOpen: (photo: Photo) => void;
}

export const PhotoGrid = forwardRef<HTMLDivElement, Props>(function PhotoGrid(
  { photos, selection, focusedId, cellSize, hasMore, loadingMore, onLoadMore, onClick, onOpen },
  ref,
) {
  const sentinel = useRef<HTMLDivElement>(null);

  // Infinite scroll.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver((entries) => entries[0]?.isIntersecting && onLoadMore(), {
      rootMargin: '800px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, onLoadMore]);

  // Keep the keyboard focus visible.
  useEffect(() => {
    if (!focusedId) return;
    document.querySelector(`[data-photo-id="${focusedId}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [focusedId]);

  return (
    <Box flex="1" overflowY="auto" p="3">
      <Grid ref={ref} templateColumns={`repeat(auto-fill, minmax(${cellSize}px, 1fr))`} gap="2">
        {photos.map((photo) => (
          <PhotoCard
            key={photo.id}
            photo={photo}
            selected={selection.has(photo.id)}
            focused={photo.id === focusedId}
            onClick={onClick}
            onOpen={onOpen}
          />
        ))}
      </Grid>
      <div ref={sentinel} />
      {loadingMore && (
        <Center py="4">
          <Spinner color="orange.solid" />
        </Center>
      )}
    </Box>
  );
});
