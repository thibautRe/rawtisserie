import { Box, Circle, HStack, Image } from '@chakra-ui/react';
import { Check, Star, X } from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Photo } from '@rawtisserie/api';
import { LABEL_COLORS } from './FilterSidebar.tsx';

const HEIGHT = 64;
const WIDTH = (HEIGHT * 3) / 2;
const GAP = 4;
const STRIDE = WIDTH + GAP;
/** Thumbnails rendered past each edge. */
const OVERSCAN = 6;
/** Positions asked for this many strips' widths past each edge. */
const PREFETCH_SCREENS = 2;

/**
 * A strip of photos, the current one in the middle: under the developer, and in the
 * culling loupe. Room is kept for every photo and only those in view are rendered (a
 * grey box until a photo is in), so a long list scrolls at once.
 */
export const FilmRoll = memo(function FilmRoll({
  items,
  current,
  onRange,
  onSelect,
  badges = false,
  dark = false,
}: {
  /** One slot per photo, undefined until it's in. */
  items: (Photo | undefined)[];
  /** The current photo's position (-1: none). */
  current: number;
  /** Positions in (or near) view: those not in yet are wanted. */
  onRange?: (start: number, end: number) => void;
  onSelect: (photo: Photo, index: number) => void;
  /** Rating, flag and colour label on each photo, as in the library's grid. */
  badges?: boolean;
  /** On the loupe's black. */
  dark?: boolean;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ width: 0, left: 0 });
  useLayoutEffect(() => {
    const el = strip.current;
    if (!el) return;
    const measure = () => setView((v) => ({ ...v, width: el.clientWidth }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Room on both sides so the first and last photos can be centred.
  const lead = Math.max(0, view.width / 2 - WIDTH / 2);
  const first = Math.max(0, Math.floor((view.left - lead) / STRIDE) - OVERSCAN);
  const last = Math.min(items.length - 1, Math.ceil((view.left + view.width - lead) / STRIDE) + OVERSCAN);

  useEffect(() => {
    if (!view.width || !items.length) return;
    const ahead = Math.ceil((PREFETCH_SCREENS * view.width) / STRIDE);
    onRange?.(Math.max(0, first - ahead), Math.min(items.length - 1, last + ahead));
  }, [first, last, items.length, view.width, onRange]);

  // Centre the current photo: at once when it first shows, smoothly after that.
  const centred = useRef(false);
  useLayoutEffect(() => {
    const el = strip.current;
    if (!el || current < 0 || !view.width) return;
    el.scrollTo({ left: current * STRIDE, behavior: centred.current ? 'smooth' : 'instant' });
    centred.current = true;
  }, [current, view.width]);

  const shown: number[] = [];
  for (let i = first; i <= last; i++) shown.push(i);
  return (
    <Box
      ref={strip}
      h={`${HEIGHT + 12}px`}
      flexShrink={0}
      overflowX="auto"
      overflowY="hidden"
      borderTopWidth={dark ? 0 : '1px'}
      bg={dark ? 'blackAlpha.800' : 'bg.panel'}
      scrollbarWidth="thin"
      onScroll={(e) => {
        const left = e.currentTarget.scrollLeft;
        setView((v) => (v.left === left ? v : { ...v, left }));
      }}
      // A mouse wheel scrolls it sideways.
      onWheel={(e) => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
      }}
    >
      <Box position="relative" h="full" w={`${2 * lead + Math.max(0, items.length * STRIDE - GAP)}px`}>
        {shown.map((i) => {
          const photo = items[i];
          const left = `${lead + i * STRIDE}px`;
          if (!photo)
            return (
              <Box
                key={`at-${i}`}
                position="absolute"
                top="1.5"
                left={left}
                w={`${WIDTH}px`}
                h={`${HEIGHT}px`}
                bg={dark ? 'whiteAlpha.100' : 'bg.muted'}
                borderRadius="xs"
              />
            );
          return (
            <RollItem
              key={photo.id}
              photo={photo}
              index={i}
              left={left}
              current={i === current}
              badges={badges}
              dark={dark}
              onSelect={onSelect}
            />
          );
        })}
      </Box>
    </Box>
  );
});

/**
 * One photo of the roll. Memoised: the list is polled while previews render (the one
 * being developed, after each edit), and only the photos that changed should restyle.
 */
const RollItem = memo(function RollItem({
  photo,
  index,
  left,
  current,
  badges,
  dark,
  onSelect,
}: {
  photo: Photo;
  index: number;
  left: string;
  current: boolean;
  badges: boolean;
  dark: boolean;
  onSelect: (photo: Photo, index: number) => void;
}) {
  const bar = badges && (photo.rating > 0 || photo.flag || photo.colorLabel);
  return (
    <Box
      as="button"
      data-roll-id={photo.id}
      position="absolute"
      top="1.5"
      left={left}
      w={`${WIDTH}px`}
      h={`${HEIGHT}px`}
      bg={dark ? 'whiteAlpha.100' : 'bg.muted'}
      borderRadius="xs"
      overflow="hidden"
      // Not dimmed: neighbours are there to compare brightness with. The current one is
      // outlined in orange, the one under the pointer in grey.
      outline="2px solid"
      outlineColor={current ? 'orange.solid' : 'transparent'}
      outlineOffset="-2px"
      _hover={current ? undefined : { outlineColor: dark ? 'whiteAlpha.600' : 'fg.muted' }}
      title={photo.filename}
      aria-current={current || undefined}
      onClick={() => !current && onSelect(photo, index)}
    >
      {photo.thumbUrl && <Image src={photo.thumbUrl} alt={photo.filename} w="full" h="full" objectFit="contain" />}
      {bar && (
        <HStack
          position="absolute"
          insetX="0"
          bottom="0"
          h="3.5"
          px="1"
          gap="0.5"
          bg="blackAlpha.600"
          color="white"
          pointerEvents="none"
        >
          <HStack gap="0" color="orange.300">
            {Array.from({ length: photo.rating }, (_, i) => (
              <Star key={i} size={8} fill="currentColor" />
            ))}
          </HStack>
          <Box flex="1" />
          {photo.colorLabel && <Circle size="1.5" bg={LABEL_COLORS[photo.colorLabel]} />}
          {photo.flag === 'picked' && <Check size={9} />}
          {photo.flag === 'rejected' && <X size={9} color="var(--chakra-colors-red-400)" />}
        </HStack>
      )}
    </Box>
  );
});
