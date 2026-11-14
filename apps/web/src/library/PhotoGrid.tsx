import { Box, Grid } from '@chakra-ui/react';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Photo } from '../api/types.ts';
import type { ImportItem } from './imports.ts';
import { PendingCard } from './PendingCard.tsx';
import { GRID_GAP, GROUP_BOX_CLASS, PhotoCard } from './PhotoCard.tsx';

/** The scroller's padding, in px. */
const PADDING = 12;
/** Rows rendered above and below the visible ones. */
const OVERSCAN_ROWS = 3;
/** Pages asked for this many screens ahead of the scroll, either way. */
const PREFETCH_SCREENS = 1.5;

interface Props {
  /** One slot per photo in the library's list, undefined until its page is in. */
  items: (Photo | undefined)[];
  selection: Set<string>;
  focusedId: string | null;
  /** The focused photo's position, kept in view. */
  focusedIndex: number;
  columns: number;
  /** Positions on (or near) the screen: their pages are wanted. */
  onRange: (start: number, end: number) => void;
  /** Where to scroll to once the list's size is known (coming back to the library). */
  initialScrollTop?: number;
  onScroll?: (top: number) => void;
  onClick: (e: React.MouseEvent, photo: Photo) => void;
  /** Double-click (none: nothing happens). */
  onOpen?: (photo: Photo) => void;
  /** Files being imported, shown before the photos (positions above are the photos'). */
  pending?: ImportItem[];
}

/**
 * The library's grid, `columns` square cells wide. Room is kept for every photo, and
 * only the rows on screen are rendered (a grey box where a page isn't in yet), so
 * scrolling anywhere is immediate.
 */
export function PhotoGrid({
  items,
  selection,
  focusedId,
  focusedIndex,
  columns,
  onRange,
  initialScrollTop = 0,
  onScroll,
  onClick,
  onOpen,
  pending = [],
}: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ width: 0, height: 0, top: initialScrollTop });

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setView((v) => ({ ...v, width: el.clientWidth, height: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cell = Math.max(1, (view.width - 2 * PADDING - (columns - 1) * GRID_GAP) / columns);
  const rowHeight = cell + GRID_GAP;
  // Cells: the pending files, then the photos.
  const lead = pending.length;
  const rows = Math.ceil((lead + items.length) / columns);
  const height = rows ? rows * rowHeight - GRID_GAP : 0;

  // Restore the scroll position once there's room for it.
  const pendingScroll = useRef(initialScrollTop > 0 ? initialScrollTop : null);
  useLayoutEffect(() => {
    const el = scroller.current;
    const target = pendingScroll.current;
    if (!el || target === null || !view.width || height + 2 * PADDING < target + el.clientHeight) return;
    el.scrollTop = target;
    pendingScroll.current = null;
  }, [height, view.width]);

  const first = Math.max(0, Math.floor((view.top - PADDING) / rowHeight) - OVERSCAN_ROWS);
  const last = Math.min(rows - 1, Math.ceil((view.top + view.height) / rowHeight) + OVERSCAN_ROWS);

  // Ask for the pages around what's visible.
  useEffect(() => {
    if (!view.width || !rows) return;
    const ahead = Math.ceil((PREFETCH_SCREENS * view.height) / rowHeight);
    const start = Math.max(0, first - ahead) * columns - lead;
    onRange(Math.max(0, start), Math.max(0, Math.min(rows, last + 1 + ahead) * columns - 1 - lead));
  }, [first, last, rows, columns, rowHeight, view.width, view.height, onRange, lead]);

  // Keep the keyboard focus visible.
  useEffect(() => {
    const el = scroller.current;
    if (!el || focusedIndex < 0 || !view.width) return;
    const top = PADDING + Math.floor((focusedIndex + lead) / columns) * rowHeight;
    if (top < el.scrollTop) el.scrollTop = top - PADDING;
    else if (top + cell > el.scrollTop + el.clientHeight) el.scrollTop = top + cell + PADDING - el.clientHeight;
  }, [focusedId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Versions next to each other on a row share a box, highlighted together on hover. The
  // hovered card's box is by its own CSS (`PhotoCard`); its other versions' by a style
  // rule for the hovered photo (rendering the cards again is slower), also without a
  // transition on the way in.
  const hoverStyle = useRef<HTMLStyleElement>(null);
  const onHover = useCallback((photoId: string | null) => {
    if (!hoverStyle.current) return;
    hoverStyle.current.textContent = photoId
      ? `[data-group="${CSS.escape(photoId)}"] > .${GROUP_BOX_CLASS} { background-color: var(--chakra-colors-bg-emphasized); transition: none; }`
      : '';
  }, []);
  const shown: number[] = [];
  for (let i = first * columns; i < Math.min(lead + items.length, (last + 1) * columns); i++) shown.push(i);

  return (
    <Box
      ref={scroller}
      flex="1"
      overflowY="auto"
      p={`${PADDING}px`}
      onScroll={(e) => {
        const top = e.currentTarget.scrollTop;
        setView((v) => (v.top === top ? v : { ...v, top }));
        onScroll?.(top);
      }}
    >
      <style ref={hoverStyle} />
      <Box position="relative" h={`${height}px`}>
        <Grid
          position="absolute"
          insetX="0"
          top={`${first * rowHeight}px`}
          templateColumns={`repeat(${columns}, minmax(0, 1fr))`}
          gap={`${GRID_GAP}px`}
        >
          {shown.map((cellIndex) => {
            if (cellIndex < lead) return <PendingCard key={pending[cellIndex]!.key} item={pending[cellIndex]!} />;
            const i = cellIndex - lead;
            const photo = items[i];
            if (!photo) return <Placeholder key={`at-${i}`} />;
            return (
              <PhotoCard
                key={photo.id}
                photo={photo}
                selected={selection.has(photo.id)}
                focused={photo.id === focusedId}
                joinLeft={cellIndex % columns > 0 && items[i - 1]?.photoId === photo.photoId}
                joinRight={(cellIndex + 1) % columns > 0 && items[i + 1]?.photoId === photo.photoId}
                onClick={onClick}
                onOpen={onOpen}
                onHover={onHover}
              />
            );
          })}
        </Grid>
      </Box>
    </Box>
  );
}

/** A photo whose page isn't in yet. */
const Placeholder = memo(function Placeholder() {
  return <Box aspectRatio="1" bg="bg.panel" borderRadius="md" />;
});
