import { Box, Flex, Image } from '@chakra-ui/react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { usePhotos } from '../api/hooks.ts';
import type { Photo } from '../api/types.ts';
import { savedLibraryView } from '../library/libraryView.ts';

const HEIGHT = 64;

/**
 * The library's photos (with the filters and sort it was left with) as a strip under
 * the developer, the current one in the middle. A click develops another one.
 */
export const FilmRoll = memo(function FilmRoll({ currentId }: { currentId: string }) {
  const navigate = useNavigate();
  const open = useCallback((id: string) => navigate(`/versions/${id}/develop`), [navigate]);
  // The library's query when the developer was opened: it doesn't change from one photo to the next.
  const [search] = useState(() => savedLibraryView()?.search ?? '');
  const query = usePhotos(search);
  const photos = useMemo(() => query.data?.pages.flatMap((p) => p.versions) ?? [], [query.data]);
  const strip = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const found = photos.some((p) => p.id === currentId);

  // Load pages until the current photo is in, so it can be centred.
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    if (query.data && !found && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [query.data, found, hasNextPage, isFetchingNextPage, fetchNextPage]);

  // More as the strip scrolls towards its end.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage) return;
    const io = new IntersectionObserver((e) => e[0]?.isIntersecting && void fetchNextPage(), {
      root: strip.current,
      rootMargin: '0px 600px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, fetchNextPage]);

  // Centre the current photo: at once when it first shows, smoothly after that.
  const centred = useRef(false);
  useEffect(() => {
    const el = strip.current?.querySelector<HTMLElement>(`[data-roll-id="${currentId}"]`);
    if (!el || !strip.current) return;
    const s = strip.current;
    s.scrollTo({
      left: el.offsetLeft + el.offsetWidth / 2 - s.clientWidth / 2,
      behavior: centred.current ? 'smooth' : 'instant',
    });
    centred.current = true;
  }, [currentId, found]);

  if (!photos.length) return null;
  return (
    <Flex
      ref={strip}
      // The thumbnails' offsetLeft is measured from it.
      position="relative"
      h={`${HEIGHT + 12}px`}
      flexShrink={0}
      gap="1"
      px="50%"
      py="1.5"
      overflowX="auto"
      overflowY="hidden"
      borderTopWidth="1px"
      bg="bg.panel"
      scrollbarWidth="thin"
      // A mouse wheel scrolls it sideways.
      onWheel={(e) => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
      }}
    >
      {photos.map((p) => (
        <RollItem key={p.id} photo={p} current={p.id === currentId} onOpen={open} />
      ))}
      <Box ref={sentinel} flexShrink={0} w="1px" />
    </Flex>
  );
});

/**
 * One photo of the roll. Memoised: the list is polled while previews render (the one
 * being developed, after each edit), and only the photos that changed should restyle.
 */
const RollItem = memo(function RollItem({
  photo,
  current,
  onOpen,
}: {
  photo: Photo;
  current: boolean;
  onOpen: (id: string) => void;
}) {
  return (
    <Box
      as="button"
      data-roll-id={photo.id}
      flexShrink={0}
      h="full"
      aspectRatio="3 / 2"
      bg="bg.muted"
      borderRadius="xs"
      overflow="hidden"
      outline={current ? '2px solid' : undefined}
      outlineColor="orange.solid"
      outlineOffset="-2px"
      opacity={current ? 1 : 0.6}
      _hover={{ opacity: 1 }}
      title={photo.filename}
      aria-current={current || undefined}
      onClick={() => !current && onOpen(photo.id)}
    >
      {photo.thumbUrl && <Image src={photo.thumbUrl} alt={photo.filename} w="full" h="full" objectFit="contain" />}
    </Box>
  );
});
