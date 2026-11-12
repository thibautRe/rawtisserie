import { Box, Center, Grid, Spinner } from '@chakra-ui/react';
import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Photo } from '../api/types.ts';
import { GRID_GAP, PhotoCard } from './PhotoCard.tsx';

/** How many columns the grid's `auto-fill` gives, as laid out. */
export function gridColumns(grid: HTMLElement | null): number {
  if (!grid) return 1;
  return Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length);
}

interface Props {
  photos: Photo[];
  selection: Set<string>;
  focusedId: string | null;
  cellSize: number;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  /** Where to scroll to once there are enough photos (coming back to the library). */
  initialScrollTop?: number;
  onScroll?: (top: number) => void;
  onClick: (e: React.MouseEvent, photo: Photo) => void;
  onOpen: (photo: Photo) => void;
}

export const PhotoGrid = forwardRef<HTMLDivElement, Props>(function PhotoGrid(
  {
    photos,
    selection,
    focusedId,
    cellSize,
    hasMore,
    loadingMore,
    onLoadMore,
    initialScrollTop = 0,
    onScroll,
    onClick,
    onOpen,
  },
  ref,
) {
  const sentinel = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const setGrid = useCallback(
    (el: HTMLDivElement | null) => {
      grid.current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );

  // Versions next to each other on a row share a box: that needs the rows.
  const [columns, setColumns] = useState(1);
  useLayoutEffect(() => {
    const el = grid.current;
    if (!el) return;
    const measure = () => setColumns(gridColumns(el));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [cellSize]);
  const [hoveredPhoto, setHoveredPhoto] = useState<string | null>(null);

  // Restore the scroll position, as more pages load if it's further down than the
  // first ones (scrolled to the end, the sentinel asks for the next page).
  const pendingScroll = useRef(initialScrollTop > 0 ? initialScrollTop : null);
  useLayoutEffect(() => {
    const el = scroller.current;
    const target = pendingScroll.current;
    if (!el || target === null || !photos.length) return;
    el.scrollTop = target;
    if (el.scrollTop >= target - 1 || !hasMore) pendingScroll.current = null;
  }, [photos, hasMore]);

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
    <Box ref={scroller} flex="1" overflowY="auto" p="3" onScroll={(e) => onScroll?.(e.currentTarget.scrollTop)}>
      <Grid ref={setGrid} templateColumns={`repeat(auto-fill, minmax(${cellSize}px, 1fr))`} gap={`${GRID_GAP}px`}>
        {photos.map((photo, i) => (
          <PhotoCard
            key={photo.id}
            photo={photo}
            selected={selection.has(photo.id)}
            focused={photo.id === focusedId}
            joinLeft={i % columns > 0 && photos[i - 1]?.photoId === photo.photoId}
            joinRight={(i + 1) % columns > 0 && photos[i + 1]?.photoId === photo.photoId}
            hovered={hoveredPhoto === photo.photoId}
            onClick={onClick}
            onOpen={onOpen}
            onHover={setHoveredPhoto}
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
