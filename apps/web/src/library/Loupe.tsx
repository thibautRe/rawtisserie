/**
 * The culling loupe: one photo at a time over the whole window, from the library grid.
 * Arrow keys move, ratings, flags and colour labels are one key each (moving on to the
 * next photo with auto-advance), and a click or Z zooms to 100 % with tiles rendered
 * by the server (`/api/versions/:id/zoom`). The zoom stays where it is from one photo
 * to the next, to compare the focus across a burst.
 */
import { Box, Circle, Flex, HStack, IconButton, Image, Spinner, Switch, Text } from '@chakra-ui/react';
import { Check, Info, SlidersHorizontal, Star, X } from 'lucide-react';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useZoomInfo } from '../api/hooks.ts';
import { type BulkPatch, COLOR_LABELS, type Photo } from '../api/types.ts';
import { useZoom } from '../develop/useZoom.ts';
import type { ZoomLayout } from '../develop/zoom.ts';
import { formatAperture, formatDateTime, formatExposureTime, formatFocal, formatIso } from '../lib/format.ts';
import { useElementSize } from '../lib/useElementSize.ts';
import { LABEL_COLORS } from './FilterSidebar.tsx';
import { advancesOn, loupeOrder, tileLevel, tileUrl, visibleTiles } from './loupe.ts';
import { TileLoader } from './tileLoader.ts';

interface Props {
  /** What the library lists now (it may have dropped photos rated out of its filters). */
  photos: Photo[];
  startId: string;
  hasMore: boolean;
  onLoadMore: () => void;
  onChange: (id: string, patch: BulkPatch) => void;
  /** Closed on this photo. */
  onClose: (id: string) => void;
  onDevelop: (id: string) => void;
}

/** How long a photo must stay before its zoom levels are asked (which decodes it on the server). */
const ZOOM_INFO_DELAY_MS = 300;
/** Load the next page once the loupe is this close to the end of the list. */
const LOAD_MORE_AHEAD = 5;

const stored = (key: string, fallback: boolean) => {
  const v = localStorage.getItem(key);
  return v === null ? fallback : v === 'true';
};

export function Loupe({ photos, startId, hasMore, onLoadMore, onChange, onClose, onDevelop }: Props) {
  const [opened] = useState(() => photos.map((p) => p.id));
  const order = useMemo(() => loupeOrder(opened, photos), [opened, photos]);
  // Every photo seen, with the changes made here: a photo rated out of the library's
  // filters is gone from `photos`, but stays in the loupe until it closes.
  const seen = useRef(new Map<string, Photo>());
  for (const p of photos) seen.current.set(p.id, p);
  const [id, setId] = useState(startId);
  const index = Math.max(0, order.indexOf(id));
  const photo = seen.current.get(id)!;

  const [autoAdvance, setAutoAdvance] = useState(() => stored('loupe.autoAdvance', true));
  const [showInfo, setShowInfo] = useState(() => stored('loupe.info', true));
  useEffect(() => localStorage.setItem('loupe.autoAdvance', String(autoAdvance)), [autoAdvance]);
  useEffect(() => localStorage.setItem('loupe.info', String(showInfo)), [showInfo]);

  const go = (to: number) => {
    const next = order[Math.min(order.length - 1, Math.max(0, to))];
    if (next) setId(next);
  };
  useEffect(() => {
    if (hasMore && index >= order.length - LOAD_MORE_AHEAD) onLoadMore();
  }, [index, order.length, hasMore]); // eslint-disable-line react-hooks/exhaustive-deps

  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  const change = (patch: BulkPatch) => {
    seen.current.set(photo.id, { ...photo, ...patch });
    onChange(photo.id, patch);
    if (autoAdvance && advancesOn(patch)) go(index + 1);
    else forceRender();
  };

  // Preload the neighbours' previews.
  useEffect(() => {
    const images = [1, -1, 2].flatMap((d) => {
      const url = seen.current.get(order[index + d] ?? '')?.previewUrl;
      if (!url) return [];
      const img = new window.Image();
      img.src = url;
      return [img];
    });
    return () => images.forEach((img) => (img.src = ''));
  }, [index, order]);

  // ── Zoom ──
  const [win, size] = useElementSize<HTMLDivElement>();
  const stage = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<ZoomLayout | null>(null);
  const { view: zoom, zoomTo } = useZoom(win, stage, layoutRef, true, { clickToggles: true });
  const [dwelled, setDwelled] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setDwelled(id), ZOOM_INFO_DELAY_MS);
    return () => clearTimeout(t);
  }, [id]);
  const info = useZoomInfo(photo, dwelled === id || zoom !== null).data;
  const [natural, setNatural] = useState<{ id: string; width: number; height: number } | null>(null);
  const preview = natural?.id === id ? natural : null;

  const dpr = window.devicePixelRatio || 1;
  // Full size: what the server says, or until then estimated from the preview and the sensor.
  const source = info?.levels[0] ?? estimateSource(photo, preview);
  const fit = source && size.width ? Math.min(size.width / source.width, size.height / source.height) : 0;
  layoutRef.current =
    source && fit
      ? {
          windowWidth: size.width,
          windowHeight: size.height,
          fitWidth: source.width * fit,
          fitHeight: source.height * fit,
          fitScale: fit * dpr,
          sourceWidth: source.width,
          sourceHeight: source.height,
          dpr,
        }
      : null;
  const layout = layoutRef.current;

  const tiles = useMemo(() => {
    if (!info || !zoom || !layout || !preview) return [];
    const level = tileLevel(info, zoom.scale, preview.width);
    return level === null ? [] : visibleTiles(info, level, layout, zoom);
  }, [info, zoom, JSON.stringify(layout), preview]); // eslint-disable-line react-hooks/exhaustive-deps
  const [, tileLoaded] = useReducer((n: number) => n + 1, 0);
  const [loader] = useState(() => new TileLoader(tileLoaded));
  useEffect(() => () => loader.dispose(), [loader]);
  const urls = info ? tiles.map((t) => tileUrl(photo.id, info, t)) : [];
  useEffect(() => loader.want(urls), [urls.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const tilesPending = urls.some((u) => !loader.get(u));

  // ── Keys ──
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    const target = e.target as HTMLElement | null;
    if (e.metaKey || e.ctrlKey || e.altKey || target?.closest('input, textarea, select, [contenteditable]')) return;
    const key = e.key.toLowerCase();
    if (/^[0-5]$/.test(key)) change({ rating: Number(key) });
    else if (/^[6-9]$/.test(key)) {
      const label = COLOR_LABELS[Number(key) - 6]!;
      change({ colorLabel: photo.colorLabel === label ? null : label });
    } else if (key === 'p') change({ flag: photo.flag === 'picked' ? null : 'picked' });
    else if (key === 'x') change({ flag: photo.flag === 'rejected' ? null : 'rejected' });
    else if (key === 'u') change({ flag: null });
    else if (key === 'arrowright' || key === 'arrowdown' || key === 'pagedown') go(index + 1);
    else if (key === 'arrowleft' || key === 'arrowup' || key === 'pageup') go(index - 1);
    else if (key === 'home') go(0);
    else if (key === 'end') go(order.length - 1);
    else if (key === 'z') zoomTo(zoom ? null : 1);
    else if (key === 'a') setAutoAdvance((a) => !a);
    else if (key === 'i') setShowInfo((s) => !s);
    else if (key === 'd' || key === 'enter') onDevelop(photo.id);
    else if (key === 'escape' || key === 'e' || key === ' ') onClose(photo.id);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  // Before the library's own shortcuts (capture), which the loupe's replace.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const scale = zoom?.scale ?? layout?.fitScale;
  const rejected = photo.flag === 'rejected';

  return (
    <Flex position="fixed" inset="0" zIndex="modal" direction="column" bg="black" color="white" userSelect="none">
      {showInfo && (
        <HStack px="3" py="2" gap="3" bg="blackAlpha.800" flexShrink="0">
          <Text fontWeight="medium" truncate>
            {photo.filename}
            {photo.versionCount > 1 && (
              <Text as="span" color="whiteAlpha.700">
                {' '}
                · {photo.versionName ?? `Version ${photo.versionIndex}`}
              </Text>
            )}
          </Text>
          <Text color="whiteAlpha.700" textStyle="sm" whiteSpace="nowrap">
            {index + 1} / {order.length}
            {hasMore ? '+' : ''}
          </Text>
          <Box flex="1" />
          {scale !== undefined && (
            <Text color="whiteAlpha.700" textStyle="sm" minW="12" textAlign="right">
              {zoom ? `${Math.round(scale * 100)} %` : 'Fit'}
            </Text>
          )}
          <Switch.Root
            size="sm"
            colorPalette="orange"
            checked={autoAdvance}
            onCheckedChange={(e) => setAutoAdvance(e.checked)}
            title="Move on after a rating or a flag (A)"
          >
            <Switch.HiddenInput />
            <Switch.Control />
            <Switch.Label>Auto-advance</Switch.Label>
          </Switch.Root>
          <IconButton
            size="sm"
            variant="ghost"
            color="white"
            aria-label="Develop (D)"
            title="Develop (D)"
            onClick={() => onDevelop(photo.id)}
          >
            <SlidersHorizontal />
          </IconButton>
          <IconButton
            size="sm"
            variant="ghost"
            color="white"
            aria-label="Hide the details (I)"
            title="Hide the details (I)"
            onClick={() => setShowInfo(false)}
          >
            <Info />
          </IconButton>
          <IconButton
            size="sm"
            variant="ghost"
            color="white"
            aria-label="Close (Esc)"
            title="Close (Esc)"
            onClick={() => onClose(photo.id)}
          >
            <X />
          </IconButton>
        </HStack>
      )}

      <Box ref={win} flex="1" minH="0" position="relative" overflow="hidden" touchAction="none" cursor="zoom-in">
        {/* Always there, so that the preview loads (its size makes the layout). */}
        <Box
          ref={stage}
          position="absolute"
          top="0"
          left="0"
          lineHeight="0"
          transformOrigin="0 0"
          opacity={rejected ? 0.6 : 1}
          visibility={layout ? 'visible' : 'hidden'}
          style={{ width: layout?.fitWidth ?? 0, height: layout?.fitHeight ?? 0 }}
        >
          {photo.thumbUrl && (
            <Image src={photo.thumbUrl} alt="" position="absolute" inset="0" w="full" h="full" draggable={false} />
          )}
          {photo.previewUrl && (
            <Image
              key={photo.previewUrl}
              src={photo.previewUrl}
              alt={photo.filename}
              position="absolute"
              inset="0"
              w="full"
              h="full"
              draggable={false}
              onLoad={(e) =>
                setNatural({ id: photo.id, width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })
              }
            />
          )}
          {info &&
            tiles.map((t) => {
              const blob = loader.get(tileUrl(photo.id, info, t));
              return (
                blob && (
                  <img
                    key={`${t.level}/${t.col}/${t.row}`}
                    src={blob}
                    alt=""
                    draggable={false}
                    style={{
                      position: 'absolute',
                      left: `${100 * t.left}%`,
                      top: `${100 * t.top}%`,
                      width: `${100 * t.width}%`,
                      height: `${100 * t.height}%`,
                      imageRendering: zoom && zoom.scale > 1 ? 'pixelated' : 'auto',
                    }}
                  />
                )
              );
            })}
        </Box>
        {(!photo.previewUrl || (zoom && tilesPending)) && (
          <Spinner position="absolute" bottom="3" right="3" size="sm" color="whiteAlpha.800" />
        )}
        {!photo.thumbUrl && !photo.previewUrl && (
          <Text position="absolute" inset="0" display="grid" placeItems="center" color="whiteAlpha.700">
            {photo.renderStatus === 'failed' ? 'This photo could not be developed.' : 'Developing…'}
          </Text>
        )}
      </Box>

      {showInfo && (
        <HStack px="3" py="2" gap="4" bg="blackAlpha.800" flexShrink="0" textStyle="sm">
          <HStack gap="0.5" title="Rating (0–5)">
            {[1, 2, 3, 4, 5].map((n) => (
              <IconButton
                key={n}
                size="xs"
                variant="ghost"
                color={n <= photo.rating ? 'orange.300' : 'whiteAlpha.500'}
                aria-label={`${n} star${n === 1 ? '' : 's'}`}
                onClick={() => change({ rating: photo.rating === n ? 0 : n })}
              >
                <Star fill={n <= photo.rating ? 'currentColor' : 'none'} />
              </IconButton>
            ))}
          </HStack>
          <HStack gap="1">
            <IconButton
              size="xs"
              variant={photo.flag === 'picked' ? 'solid' : 'ghost'}
              colorPalette="green"
              color={photo.flag === 'picked' ? undefined : 'whiteAlpha.700'}
              aria-label="Pick (P)"
              title="Pick (P)"
              onClick={() => change({ flag: photo.flag === 'picked' ? null : 'picked' })}
            >
              <Check />
            </IconButton>
            <IconButton
              size="xs"
              variant={rejected ? 'solid' : 'ghost'}
              colorPalette="red"
              color={rejected ? undefined : 'whiteAlpha.700'}
              aria-label="Reject (X)"
              title="Reject (X)"
              onClick={() => change({ flag: rejected ? null : 'rejected' })}
            >
              <X />
            </IconButton>
          </HStack>
          <HStack gap="1.5">
            {COLOR_LABELS.map((label, i) => (
              <Circle
                key={label}
                as="button"
                size="3.5"
                bg={LABEL_COLORS[label]}
                opacity={photo.colorLabel === label ? 1 : 0.3}
                borderWidth={photo.colorLabel === label ? '2px' : 0}
                borderColor="white"
                cursor="pointer"
                aria-label={`${label} label (${i + 6})`}
                title={`${label[0]!.toUpperCase()}${label.slice(1)} (${i + 6})`}
                onClick={() => change({ colorLabel: photo.colorLabel === label ? null : label })}
              />
            ))}
          </HStack>
          <Text color="whiteAlpha.800" truncate flex="1">
            {exifLine(photo)}
          </Text>
          <Text color="whiteAlpha.600" whiteSpace="nowrap" hideBelow="lg">
            ← → move · 0–5 rate · P X U flag · 6–9 label · Z zoom · A auto-advance · Esc close
          </Text>
        </HStack>
      )}
      {!showInfo && (
        <IconButton
          position="absolute"
          top="2"
          right="2"
          size="sm"
          variant="ghost"
          color="whiteAlpha.700"
          aria-label="Show the details (I)"
          title="Show the details (I)"
          onClick={() => setShowInfo(true)}
        >
          <Info />
        </IconButton>
      )}
    </Flex>
  );
}

/**
 * The full-size image's size before the server says: the preview's shape, scaled to the
 * sensor's long edge (a crop makes it a little smaller; the server's size replaces it).
 */
function estimateSource(photo: Photo, preview: { width: number; height: number } | null) {
  if (!preview) return null;
  const long = Math.max(photo.width ?? 0, photo.height ?? 0);
  const k = long > Math.max(preview.width, preview.height) ? long / Math.max(preview.width, preview.height) : 1;
  return { width: Math.round(preview.width * k), height: Math.round(preview.height * k) };
}

function exifLine(p: Photo) {
  const camera = [p.cameraMake, p.cameraModel].filter(Boolean).join(' ');
  return [
    camera,
    p.lens,
    formatFocal(p.focalLength),
    formatAperture(p.fNumber),
    formatExposureTime(p.exposureTime),
    formatIso(p.iso),
    formatDateTime(p.capturedAt),
  ]
    .filter(Boolean)
    .join(' · ');
}
