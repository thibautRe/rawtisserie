import { Box } from '@chakra-ui/react';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Photo } from '../api/types.ts';
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
  /** Held down (phones). */
  onLongPress?: (photo: Photo) => void;
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
  onLongPress,
}: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  // `top` is always the scroller's: rows are rendered around it, so it must never be
  // ahead of where the browser actually is.
  const [view, setView] = useState({ width: 0, height: 0, top: 0 });

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
  const rows = Math.ceil(items.length / columns);
  const height = rows ? rows * rowHeight - GRID_GAP : 0;

  // Restore the scroll position once the list's size is known (as far as it goes, if
  // it's shorter now). And whenever the list's height changes: the browser may have
  // moved the scroll position (a shorter list) without a scroll event.
  const pendingScroll = useRef(initialScrollTop > 0 ? initialScrollTop : null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !view.width) return;
    const target = pendingScroll.current;
    if (target !== null && rows) {
      el.scrollTop = target;
      pendingScroll.current = null;
    }
    const top = el.scrollTop;
    setView((v) => (v.top === top ? v : { ...v, top }));
  }, [height, view.width, rows]);

  const range = (top: number) => [
    Math.max(0, Math.floor((top - PADDING) / rowHeight) - OVERSCAN_ROWS),
    Math.min(rows - 1, Math.ceil((top + view.height) / rowHeight) + OVERSCAN_ROWS),
  ];
  const [first, last] = range(view.top) as [number, number];
  const sameRows = (a: number, b: number) => {
    const [ra, rb] = [range(a), range(b)];
    return ra[0] === rb[0] && ra[1] === rb[1];
  };

  // Ask for the pages around what's visible.
  useEffect(() => {
    if (!view.width || !rows) return;
    const ahead = Math.ceil((PREFETCH_SCREENS * view.height) / rowHeight);
    onRange(Math.max(0, first - ahead) * columns, Math.min(rows, last + 1 + ahead) * columns - 1);
  }, [first, last, rows, columns, rowHeight, view.width, view.height, onRange]);

  // Keep the keyboard focus visible.
  useEffect(() => {
    const el = scroller.current;
    if (!el || focusedIndex < 0 || !view.width) return;
    const top = PADDING + Math.floor(focusedIndex / columns) * rowHeight;
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
  const rendered = new Set<string>();
  for (let i = first * columns; i < Math.min(items.length, (last + 1) * columns); i++) shown.push(i);

  return (
    <Box
      ref={scroller}
      flex="1"
      overflowY="auto"
      p={`${PADDING}px`}
      onScroll={(e) => {
        const top = e.currentTarget.scrollTop;
        // Rendered again only when other rows come into range: most scroll events don't
        // change which.
        setView((v) => (v.top === top || sameRows(v.top, top) ? v : { ...v, top }));
        onScroll?.(top);
      }}
    >
      <style ref={hoverStyle} />
      {/* Plain elements, sized inline: as style props, each new size or offset would add a
          CSS rule (the browser restyles the page for each), and they render as it scrolls. */}
      <div style={{ position: 'relative', height }}>
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: first * rowHeight,
            display: 'grid',
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            gap: GRID_GAP,
          }}
        >
          {shown.map((i) => {
            const photo = items[i];
            // Keys must be unique: a duplicate would leave stray cards behind.
            if (!photo || rendered.has(photo.id)) return <Placeholder key={`at-${i}`} />;
            rendered.add(photo.id);
            return (
              <PhotoCard
                key={photo.id}
                photo={photo}
                selected={selection.has(photo.id)}
                focused={photo.id === focusedId}
                joinLeft={i % columns > 0 && items[i - 1]?.photoId === photo.photoId}
                joinRight={(i + 1) % columns > 0 && items[i + 1]?.photoId === photo.photoId}
                onClick={onClick}
                onOpen={onOpen}
                onLongPress={onLongPress}
                onHover={onHover}
              />
            );
          })}
        </div>
      </div>
    </Box>
  );
}

/** A photo whose page isn't in yet. */
const Placeholder = memo(function Placeholder() {
  return <div className="photo-placeholder" />;
});
