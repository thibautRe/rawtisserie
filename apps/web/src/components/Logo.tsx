/**
 * RAWtisserie's logo (roadmap M9; the ideas that led to it are on `/ui/logo`): a drumstick
 * whose skin is a Bayer sensor, the photosites going from raw (sensor colours, at the tip)
 * to well done (towards the bone, top left), each one either raw or cooked. Two drawings of it:
 * `small` is flat (icons, the menu button, the favicon: `assets/favicon.svg` is a copy),
 * `large` has its photosites as crossing strips, shaded like threads, and lit (the login
 * page, the developer's landing).
 */
import { Box, HStack, Stack, Text } from '@chakra-ui/react';
import { useId } from 'react';

/** The meat, drawn along +x (bone towards +x), placed on the page by `MEAT_TRANSFORM`. */
const MEAT = 'M -19 0 C -19 -16, 3 -18, 12 -8 L 19 -4 L 19 4 L 12 8 C 3 18, -19 16, -19 0 Z';
/** Bone to the top left, meat to the bottom right. */
const MEAT_TRANSFORM = 'translate(37 37) rotate(225)';

const BAYER = { r: '#d6533a', g: '#97a446', b: '#3e6f8e' };
/** From raw to well done. */
const DONENESS = ['#f2b5a4', '#eb9a6a', '#dd8237', '#b8601f', '#7d3c18'];
const BONE = '#efdcbc';
const EDGE = '#4a2410';
/** Between the photosites: warmer than the outline, so the skin doesn't go dark. */
const GROUT = '#7a3a16';
/** The photosites' pitch and the gap between them, in 64ths of the mark. */
const PITCH = 12;
const GAP = 1;

function mix(a: string, b: string, t: number) {
  const ch = (c: string, k: number) => parseInt(c.slice(1 + 2 * k, 3 + 2 * k), 16);
  const out = [0, 1, 2].map((k) => Math.round(ch(a, k) + (ch(b, k) - ch(a, k)) * t));
  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function doneness(t: number) {
  const x = Math.min(Math.max(t, 0), 1) * (DONENESS.length - 1);
  const k = Math.min(Math.floor(x), DONENESS.length - 2);
  return mix(DONENESS[k]!, DONENESS[k + 1]!, x - k);
}

/** The meat's outline as a polygon, on the page. */
const MEAT_POLYGON = (() => {
  const cubic = (p: number[][], steps: number) =>
    Array.from({ length: steps }, (_, s) => {
      const t = (s + 1) / steps;
      const u = 1 - t;
      return [0, 1].map(
        (k) => u * u * u * p[0]![k]! + 3 * u * u * t * p[1]![k]! + 3 * u * t * t * p[2]![k]! + t * t * t * p[3]![k]!,
      );
    });
  const local = [
    [-19, 0],
    ...cubic(
      [
        [-19, 0],
        [-19, -16],
        [3, -18],
        [12, -8],
      ],
      24,
    ),
    [19, -4],
    [19, 4],
    [12, 8],
    ...cubic(
      [
        [12, 8],
        [3, 18],
        [-19, 16],
        [-19, 0],
      ],
      24,
    ),
  ];
  const a = (225 * Math.PI) / 180;
  return local.map(([x, y]) => [37 + x! * Math.cos(a) - y! * Math.sin(a), 37 + x! * Math.sin(a) + y! * Math.cos(a)]);
})();

function inMeat(x: number, y: number) {
  let inside = false;
  for (let k = 0, l = MEAT_POLYGON.length - 1; k < MEAT_POLYGON.length; l = k++) {
    const [xk, yk] = MEAT_POLYGON[k]!;
    const [xl, yl] = MEAT_POLYGON[l]!;
    if (yk! > y !== yl! > y && x < ((xl! - xk!) * (y - yk!)) / (yl! - yk!) + xk!) inside = !inside;
  }
  return inside;
}

type Cell = { x: number; y: number; i: number; j: number; cover: number };

/**
 * The photosites over the meat, square to the page, placed to leave the fewest slivers
 * along the outline; cells mostly outside are left out (the edge shows there).
 */
const CELLS: Cell[] = (() => {
  const p = PITCH;
  const coverage = (x: number, y: number) => {
    let n = 0;
    for (let a = 0; a < 6; a++)
      for (let b = 0; b < 6; b++) if (inMeat(x + ((a + 0.5) * p) / 6, y + ((b + 0.5) * p) / 6)) n++;
    return n / 36;
  };
  let best: { score: number; cells: Cell[] } | null = null;
  for (let ox = 0; ox < p; ox += p / 8) {
    for (let oy = 0; oy < p; oy += p / 8) {
      let score = 0;
      const cells: Cell[] = [];
      for (let i = 0; i * p + oy - p < 64; i++) {
        for (let j = 0; j * p + ox - p < 64; j++) {
          const x = ox + (j - 1) * p;
          const y = oy + (i - 1) * p;
          const c = coverage(x, y);
          if (c > 0.02 && c < 0.6) score += 1 - Math.abs(c - 0.3);
          if (c >= 0.3) cells.push({ x, y, i, j, cover: c });
        }
      }
      if (!best || score < best.score) best = { score, cells };
    }
  }
  const cells = best!.cells;
  const i0 = Math.min(...cells.map((c) => c.i));
  const j0 = Math.min(...cells.map((c) => c.j));
  return cells.map((c) => ({ ...c, i: c.i - i0, j: c.j - j0 }));
})();

type Channel = 'r' | 'g' | 'b';
/** RGGB. */
const channel = (i: number, j: number): Channel => (i % 2 ? (j % 2 ? 'b' : 'g') : j % 2 ? 'g' : 'r');

/**
 * A photosite is raw (its sensor colour) or cooked, never between (blends of blue and
 * orange are grey). More are cooked towards the bone, in a scattered order.
 */
function cellColour({ x, y, i, j }: Cell) {
  // Raw at the tip (bottom right), done by the bone (top left).
  const t = Math.min(1, Math.max(0, (104 - (x + PITCH / 2) - (y + PITCH / 2)) / 54));
  const scatter = ((i * 7 + j * 13 + ((i * j) % 5) * 3) % 10) / 10;
  return t > 0.25 + scatter * 0.45 ? doneness(0.35 + 0.6 * t) : BAYER[channel(i, j)];
}

/** The logo's mark, `size` pixels square. */
export function LogoMark({ size = 32, variant = 'small' }: { size?: number; variant?: 'small' | 'large' }) {
  const id = `logo-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const large = variant === 'large';
  const stretch = large ? PITCH * 0.16 : PITCH * 0.045;
  // Large: cells reach into their neighbours' margins, crossing strips with even gaps.
  const reach = large ? stretch : 0;
  // The bevel is about a 64th wide whatever the cell.
  const lit = 1.1 / PITCH;
  const shaded = 0.9 / PITCH;
  const bevel = (across: boolean) => (
    <linearGradient id={`${id}-${across ? 'across' : 'down'}`} x1="0" y1="0" x2={across ? 0 : 1} y2={across ? 1 : 0}>
      <stop offset="0" stopColor="#fff" stopOpacity="0.4" />
      <stop offset={lit} stopColor="#fff" stopOpacity="0.4" />
      <stop offset={lit * 1.4} stopColor="#fff" stopOpacity="0" />
      <stop offset={1 - shaded * 1.4} stopColor="#000" stopOpacity="0" />
      <stop offset={1 - shaded} stopColor="#000" stopOpacity="0.22" />
      <stop offset="1" stopColor="#000" stopOpacity="0.22" />
    </linearGradient>
  );
  const bone = (fill: string, grow: number) => (
    <>
      <rect x="15" y={-2.75 - grow} width="17" height={5.5 + 2 * grow} fill={fill} />
      <circle cx="32" cy="-3.6" r={4.2 + grow} fill={fill} />
      <circle cx="32" cy="3.6" r={4.2 + grow} fill={fill} />
    </>
  );
  return (
    // Its size inline too: inside a button, Chakra's icon styles would shrink it to the icon size.
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden
      focusable="false"
      style={{ flexShrink: 0, width: size, height: size }}
    >
      <defs>
        <clipPath id={`${id}-meat`}>
          <path d={MEAT} transform={MEAT_TRANSFORM} />
        </clipPath>
        {large && (
          <>
            {bevel(true)}
            {bevel(false)}
            <radialGradient id={`${id}-light`} cx="0.38" cy="0.3" r="0.75">
              <stop offset="0" stopColor="#fff" stopOpacity="0.22" />
              <stop offset="0.5" stopColor="#fff" stopOpacity="0" />
              <stop offset="1" stopColor="#000" stopOpacity="0.3" />
            </radialGradient>
            <linearGradient id={`${id}-bone`} gradientUnits="userSpaceOnUse" x1="0" y1="7" x2="0" y2="-7">
              <stop offset="0" stopColor="#f8ecd6" />
              <stop offset="1" stopColor="#d6b98c" />
            </linearGradient>
            <filter id={`${id}-blur`} x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="1.3" />
            </filter>
            <filter id={`${id}-soft`} x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="0.35" />
            </filter>
            <filter id={`${id}-shadow`} x="-20%" y="-20%" width="140%" height="150%">
              <feDropShadow dx="0.4" dy="1.3" stdDeviation="1.1" floodColor="#000" floodOpacity="0.35" />
            </filter>
          </>
        )}
      </defs>
      <g filter={large ? `url(#${id}-shadow)` : undefined}>
        <g transform={MEAT_TRANSFORM}>
          {bone(EDGE, GAP)}
          {bone(large ? `url(#${id}-bone)` : BONE, 0)}
          <path d={MEAT} fill={GROUT} />
        </g>
        <g clipPath={`url(#${id}-meat)`}>
          {CELLS.map((cell) => {
            const { x, y, i, j, cover } = cell;
            const across = channel(i, j) !== 'g';
            const r = across
              ? {
                  x: x + GAP / 2 - reach,
                  y: y + GAP / 2 + stretch,
                  width: PITCH - GAP + 2 * reach,
                  height: PITCH - GAP - 2 * stretch,
                }
              : {
                  x: x + GAP / 2 + stretch,
                  y: y + GAP / 2 - reach,
                  width: PITCH - GAP - 2 * stretch,
                  height: PITCH - GAP + 2 * reach,
                };
            return (
              <g key={`${i}-${j}`}>
                <rect {...r} rx={PITCH * 0.13} fill={cellColour(cell)} />
                {/* No bevel on cells mostly under the outline: their lit edge shows as a stray bar. */}
                {large && cover > 0.6 && (
                  <rect {...r} rx={PITCH * 0.13} fill={`url(#${id}-${across ? 'across' : 'down'})`} />
                )}
              </g>
            );
          })}
          {large && (
            <>
              <rect x="19" y="18" width="40" height="42" fill={`url(#${id}-light)`} />
              {/* Inner shadow: the outline, blurred, inside the meat. */}
              <path
                d={MEAT}
                transform={MEAT_TRANSFORM}
                fill="none"
                stroke="#000"
                strokeOpacity="0.4"
                strokeWidth="3"
                filter={`url(#${id}-blur)`}
              />
            </>
          )}
        </g>
        <path d={MEAT} transform={MEAT_TRANSFORM} fill="none" stroke={EDGE} strokeWidth={GAP * 1.6} />
        {large && (
          <path
            d="M -9 11.6 C -3 12.4, 4 11.2, 9.5 7.6"
            transform={MEAT_TRANSFORM}
            fill="none"
            stroke="#fff"
            strokeOpacity="0.7"
            strokeWidth="1.6"
            strokeLinecap="round"
            filter={`url(#${id}-soft)`}
          />
        )}
      </g>
    </svg>
  );
}

/** The name: `RAW` heavier, the half of the pun people miss. */
export function Wordmark({ fontSize }: { fontSize: string }) {
  return (
    <Text as="span" fontFamily="heading" fontSize={fontSize} lineHeight="1" letterSpacing="-0.02em" whiteSpace="nowrap">
      <Box as="span" fontWeight="800">
        RAW
      </Box>
      <Box as="span" fontWeight="400">
        tisserie
      </Box>
    </Text>
  );
}

/** The tagline: a little cheeky, so small and in italics. */
export function Tagline({ fontSize = '12px' }: { fontSize?: string }) {
  return (
    <Text as="span" fontSize={fontSize} fontStyle="italic" color="fg.muted" lineHeight="1.2" whiteSpace="nowrap">
      from raw to well done
    </Text>
  );
}

/**
 * The mark and the name. `tagline`: with the tagline right under the name, the two
 * centred against the mark. `stacked`: the large mark above the name.
 */
export function Logo({
  size = 'md',
  stacked,
  tagline,
}: {
  size?: 'md' | 'lg' | 'xl';
  stacked?: boolean;
  tagline?: boolean;
}) {
  if (stacked) {
    return (
      <Stack align="center" gap="3">
        <LogoMark size={size === 'xl' ? 128 : 88} variant="large" />
        <Stack align="center" gap="1.5">
          <Wordmark fontSize={size === 'xl' ? '36px' : '26px'} />
          {tagline && <Tagline fontSize={size === 'xl' ? '14px' : '12px'} />}
        </Stack>
      </Stack>
    );
  }
  // The large mark from 40 px: below that its shading is lost. With the tagline, the mark
  // grows to the height of both lines.
  const { mark, font, gap, small } = {
    md: { mark: 28, font: '19px', gap: '2', small: '11px' },
    lg: { mark: 40, font: '24px', gap: '2.5', small: '12px' },
    xl: { mark: 52, font: '30px', gap: '3', small: '13px' },
  }[size];
  const markSize = tagline ? Math.round(mark * 1.25) : mark;
  return (
    <HStack gap={gap} align="center">
      <LogoMark size={markSize} variant={markSize >= 40 ? 'large' : 'small'} />
      {tagline ? (
        <Stack gap="1" align="start">
          <Wordmark fontSize={font} />
          <Tagline fontSize={small} />
        </Stack>
      ) : (
        <Wordmark fontSize={font} />
      )}
    </HStack>
  );
}
