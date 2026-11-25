/**
 * Logo ideas (`/ui/logo`, roadmap M9): marks and wordmarks for RAWtisserie, as SVG, shown
 * on dark and light, at icon sizes and with the name. Ideation only: nothing here is used
 * by the app yet.
 *
 * The two puns: rôtisserie ("from raw to well done": a spit, turning, doneness) and
 * tisser, to weave (a Bayer sensor is a plain weave: see `Weave`). Three directions kept
 * from the first round (woven sensor, spit roast, lattice drumstick), each with variants,
 * some with photographic things in them (a lens, an optical axis).
 */
import { Box, Container, Grid, HStack, Heading, Link, Stack, Text } from '@chakra-ui/react';
import { Fragment, type ReactNode, useId } from 'react';
import { Link as RouterLink } from 'react-router';

/** From raw to well done. */
const DONENESS = ['#f2b5a4', '#eb9a6a', '#dd8237', '#b8601f', '#7d3c18'] as const;
/** Bayer's colours, warmed up a little. */
const BAYER = { r: '#d6533a', g: '#97a446', b: '#3e6f8e' };
const GOLD = '#dd8237';
const CRUST = '#f0c38a';
const STEEL = '#a8a29b';
/** Lens elements: glass, not meat. */
const GLASS = ['#bcd9e6', '#8fbbd0'] as const;
const BONE = '#efdcbc';
const DARK = '#1b1a19';
const LIGHT = '#f7f5f2';

type MarkProps = { size?: number };

/** An id for `clipPath`s and gradients, unique per drawing (the same mark is drawn many times). */
function useSvgId(name: string) {
  return `${name}-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

/** Mixes two `#rrggbb` colours. */
function mix(a: string, b: string, t: number) {
  const ch = (c: string, k: number) => parseInt(c.slice(1 + 2 * k, 3 + 2 * k), 16);
  const out = [0, 1, 2].map((k) => Math.round(ch(a, k) + (ch(b, k) - ch(a, k)) * t));
  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** A point along the doneness ramp, `t` in [0, 1]. */
function doneness(t: number) {
  const x = Math.min(Math.max(t, 0), 1) * (DONENESS.length - 1);
  const k = Math.min(Math.floor(x), DONENESS.length - 2);
  return mix(DONENESS[k]!, DONENESS[k + 1]!, x - k);
}

function Svg({ size, label, children }: { size: number; label: string; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={label}>
      {children}
    </svg>
  );
}

/**
 * A plain weave of `n` threads each way. With the weft alternating red and blue and every
 * warp thread green, and the weft on top where row + column is even, what shows at each
 * crossing is exactly a Bayer pattern (RGGB): green is the warp, hence twice as many.
 */
function Weave({
  n = 4,
  size = 64,
  warp = () => BAYER.g,
  weft = (i: number) => (i % 2 ? BAYER.b : BAYER.r),
  thread = 0.74,
  shade = 0.35,
  overhang = 0,
}: {
  n?: number;
  size?: number;
  warp?: (j: number) => string;
  weft?: (i: number) => string;
  /** The thread's width, as a fraction of the pitch. */
  thread?: number;
  /** How dark the shadow next to a thread on top. */
  shade?: number;
  /** How far the threads go past the weave, loose. */
  overhang?: number;
}) {
  const pitch = size / n;
  const w = pitch * thread;
  const off = (pitch - w) / 2;
  const s = Math.max(0.8, pitch * 0.09);
  const cells: ReactNode[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = j * pitch + off;
      const y = i * pitch + off;
      if ((i + j) % 2 === 0) {
        // Weft on top: redraw it over the warp, shadow on the warp either side.
        cells.push(
          <g key={`${i}-${j}`}>
            <rect x={x - off} y={y} width={pitch} height={w} fill={weft(i)} />
            {shade > 0 && <rect x={x} y={y - s} width={w} height={s} fill="#000" opacity={shade} />}
            {shade > 0 && <rect x={x} y={y + w} width={w} height={s} fill="#000" opacity={shade} />}
          </g>,
        );
      } else if (shade > 0) {
        cells.push(
          <g key={`${i}-${j}`}>
            <rect x={x - s} y={y} width={s} height={w} fill="#000" opacity={shade} />
            <rect x={x + w} y={y} width={s} height={w} fill="#000" opacity={shade} />
          </g>,
        );
      }
    }
  }
  const r = overhang > 0 ? w / 2 : 0;
  return (
    <g>
      {Array.from({ length: n }, (_, i) => (
        <rect
          key={`h${i}`}
          x={-overhang}
          y={i * pitch + off}
          width={size + 2 * overhang}
          height={w}
          rx={r}
          fill={weft(i)}
        />
      ))}
      {Array.from({ length: n }, (_, j) => (
        <rect
          key={`v${j}`}
          x={j * pitch + off}
          y={-overhang}
          width={w}
          height={size + 2 * overhang}
          rx={r}
          fill={warp(j)}
        />
      ))}
      {cells}
    </g>
  );
}

/** A lens seen from the front: barrel, glass and a glint, `children` behind the glass. */
function Lens({
  r = 30,
  children,
  cx = 32,
  cy = 32,
  glint = true,
}: {
  r?: number;
  children?: ReactNode;
  cx?: number;
  cy?: number;
  glint?: boolean;
}) {
  const id = useSvgId('lens');
  const g = r * 0.8;
  return (
    <g transform={`translate(${cx} ${cy})`}>
      <defs>
        <clipPath id={id}>
          <circle r={g} />
        </clipPath>
      </defs>
      <circle r={r} fill="#2e2a27" />
      <circle r={r * 0.9} fill="none" stroke="#4a4440" strokeWidth={r * 0.03} />
      <circle r={g} fill="#14191d" />
      <g clipPath={`url(#${id})`}>{children}</g>
      {glint && (
        <path
          d={`M ${-g * 0.62} ${-g * 0.38} A ${g * 0.72} ${g * 0.72} 0 0 1 ${-g * 0.1} ${-g * 0.72}`}
          fill="none"
          stroke="#fff"
          strokeOpacity="0.55"
          strokeWidth={r * 0.07}
          strokeLinecap="round"
        />
      )}
      <circle r={g} fill="none" stroke="#0b0b0b" strokeWidth={r * 0.05} />
    </g>
  );
}

// ——— 1. Woven sensor ———

function WeaveTile({
  size = 64,
  label,
  bg = '#141312',
  children,
}: MarkProps & { label: string; bg?: string; children: ReactNode }) {
  const id = useSvgId('tile');
  return (
    <Svg size={size} label={label}>
      <defs>
        <clipPath id={id}>
          <rect x="2" y="2" width="60" height="60" rx="13" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${id})`}>
        <rect width="64" height="64" fill={bg} />
        {children}
      </g>
    </Svg>
  );
}

const inTile = (weave: ReactNode) => <g transform="translate(2 2) scale(0.9375)">{weave}</g>;

function WovenBayer({ size }: MarkProps) {
  return (
    <WeaveTile size={size} label="Woven sensor">
      {inTile(<Weave />)}
    </WeaveTile>
  );
}

function WovenToasted({ size }: MarkProps) {
  return (
    <WeaveTile size={size} label="Woven sensor, toasted" bg="#3a2014">
      {inTile(<Weave warp={() => CRUST} weft={(i) => (i % 2 ? DONENESS[3] : DONENESS[2])} />)}
    </WeaveTile>
  );
}

/** Raw sensor colours in the top left, cooked to crust in the bottom right. */
function WovenRamp({ size }: MarkProps) {
  const n = 5;
  return (
    <WeaveTile size={size} label="Woven, raw to done">
      {inTile(
        <Weave
          n={n}
          warp={(j) => mix(BAYER.g, CRUST, j / (n - 1))}
          weft={(i) => mix(i % 2 ? BAYER.b : BAYER.r, i % 2 ? DONENESS[4] : DONENESS[3], i / (n - 1))}
        />,
      )}
    </WeaveTile>
  );
}

/** Two threads each way, thick: the one that survives 16 px. */
function WovenChunky({ size }: MarkProps) {
  return (
    <WeaveTile size={size} label="Woven, two by two">
      {inTile(<Weave n={2} thread={0.78} weft={(i) => (i ? BAYER.b : BAYER.r)} />)}
    </WeaveTile>
  );
}

/** No tile: a scrap of fabric, threads loose at the ends (raw edges). */
function WovenLoose({ size = 64 }: MarkProps) {
  return (
    <Svg size={size} label="Woven, loose threads">
      <g transform="translate(14 14)">
        <Weave n={3} size={36} thread={0.7} overhang={10} />
      </g>
    </Svg>
  );
}

/** A weave turned 45°, big enough to fill the 64 box whichever way it's clipped. */
const onBias = (weave: (size: number) => ReactNode) => (
  <g transform="translate(32 32) rotate(45) translate(-48 -48)">{weave(96)}</g>
);

function WovenBias({ size }: MarkProps) {
  return (
    <WeaveTile size={size} label="Woven sensor on the bias">
      {onBias((s) => (
        <Weave n={6} size={s} />
      ))}
    </WeaveTile>
  );
}

function WovenBiasRamp({ size }: MarkProps) {
  const n = 6;
  return (
    <WeaveTile size={size} label="Woven, raw to done, on the bias">
      {onBias((s) => (
        <Weave
          n={n}
          size={s}
          warp={(j) => mix(BAYER.g, CRUST, j / (n - 1))}
          weft={(i) => mix(i % 2 ? BAYER.b : BAYER.r, i % 2 ? DONENESS[4] : DONENESS[3], i / (n - 1))}
        />
      ))}
    </WeaveTile>
  );
}

/** The tile itself turned: a diamond of weave, threads square to the page. */
function WovenDiamond({ size = 64 }: MarkProps) {
  const id = useSvgId('diamond');
  return (
    <Svg size={size} label="Woven diamond">
      <g transform="translate(32 32) rotate(45) scale(0.72) translate(-32 -32)">
        <defs>
          <clipPath id={id}>
            <rect x="2" y="2" width="60" height="60" rx="9" />
          </clipPath>
        </defs>
        <g clipPath={`url(#${id})`}>
          <rect width="64" height="64" fill="#141312" />
          <g transform="translate(32 32) rotate(-45) translate(-48 -48)">
            <Weave n={6} size={96} />
          </g>
        </g>
      </g>
    </Svg>
  );
}

function WovenBiasCircle({ size = 64 }: MarkProps) {
  const id = useSvgId('round');
  return (
    <Svg size={size} label="Woven sensor on the bias, round">
      <defs>
        <clipPath id={id}>
          <circle cx="32" cy="32" r="30" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${id})`}>
        <rect width="64" height="64" fill="#141312" />
        {onBias((s) => (
          <Weave n={6} size={s} />
        ))}
      </g>
    </Svg>
  );
}

function WovenLooseBias({ size = 64 }: MarkProps) {
  return (
    <Svg size={size} label="Loose threads on the bias">
      <g transform="translate(32 32) rotate(45) scale(0.8) translate(-32 -32)">
        <g transform="translate(14 14)">
          <Weave n={3} size={36} thread={0.7} overhang={10} />
        </g>
      </g>
    </Svg>
  );
}

/** The sensor behind a lens. */
function WovenLens({ size = 64 }: MarkProps) {
  return (
    <Svg size={size} label="Woven sensor behind a lens">
      <Lens r={30}>
        <g transform="translate(-24 -24) scale(0.75)">
          <Weave />
        </g>
      </Lens>
    </Svg>
  );
}

// ——— 2. Spit roast ———

/** A spit along +x in local units, crank at the start. */
function Spit({ from = 9, to = 80, crank = true }: { from?: number; to?: number; crank?: boolean }) {
  return (
    <g>
      <line x1={from} y1="0" x2={to} y2="0" stroke={STEEL} strokeWidth="3" strokeLinecap="round" />
      {crank && (
        <>
          <path
            d={`M${from} 0 V-9 H${from + 5}`}
            fill="none"
            stroke={STEEL}
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx={from + 6.5} cy="-9" r="3" fill={GOLD} />
        </>
      )}
    </g>
  );
}

/** Lays a drawing along +x on the box's diagonal, rising to the right, centred on `mid`. */
const diagonal = (children: ReactNode, mid = 42) => (
  <g transform={`translate(32 32) rotate(-45) translate(${-mid} 0)`}>{children}</g>
);

const CENTRES = [27, 45, 63];

function pixel(k: number, fill: string, side = 16) {
  return (
    <rect
      key={k}
      x={CENTRES[k]! - side / 2}
      y={-side / 2}
      width={side}
      height={side}
      rx="2"
      fill={fill}
      transform={`rotate(${k * 22.5} ${CENTRES[k]} 0)`}
    />
  );
}

const ROAST = [DONENESS[0], DONENESS[2], DONENESS[4]];

function SpitRoast({ size = 64 }: MarkProps) {
  return (
    <Svg size={size} label="Pixels on a spit">
      {diagonal(
        <>
          <Spit />
          {ROAST.map((c, k) => pixel(k, c))}
          {CENTRES.map((x) => (
            <circle key={x} cx={x} cy="0" r="1.8" fill={STEEL} />
          ))}
        </>,
      )}
    </Svg>
  );
}

function SpitWoven({ size = 64 }: MarkProps) {
  return (
    <Svg size={size} label="Pixels woven on a spit">
      {diagonal(
        <>
          {pixel(1, ROAST[1]!)}
          <Spit />
          {pixel(0, ROAST[0]!)}
          {pixel(2, ROAST[2]!)}
        </>,
      )}
    </Svg>
  );
}

/** A lens is elements threaded on an axis: the optical axis as the spit. */
function SpitOptical({ size = 64 }: MarkProps) {
  const h = 13;
  const convex = (x: number, w: number, fill: string) => (
    <ellipse cx={x} cy="0" rx={w} ry={h} fill={fill} stroke="#2c4a5a" strokeOpacity="0.5" strokeWidth="0.8" />
  );
  const concave = (x: number, w: number, b: number, fill: string) => (
    <path
      d={`M ${x - w} ${-h} Q ${x} ${-h - 1.5} ${x + w} ${-h} Q ${x + w - b} 0 ${x + w} ${h} Q ${x} ${h + 1.5} ${x - w} ${h} Q ${x - w + b} 0 ${x - w} ${-h} Z`}
      fill={fill}
      stroke="#2c4a5a"
      strokeOpacity="0.5"
      strokeWidth="0.8"
    />
  );
  return (
    <Svg size={size} label="Lens elements on a spit">
      {diagonal(
        <>
          <Spit />
          {convex(27, 5, GLASS[0])}
          {concave(45, 5, 4, GLASS[1])}
          {convex(63, 5, GLASS[0])}
        </>,
      )}
    </Svg>
  );
}

/** Over the fire, in a tile. */
function SpitFire({ size = 64 }: MarkProps) {
  const flame = (c: number, h: number, fill: string) => (
    <path
      key={`${c}-${fill}`}
      d={`M ${c - 5} 57 C ${c - 6} ${57 - h * 0.45}, ${c - 1.5} ${57 - h * 0.6}, ${c} ${57 - h} C ${c + 1.5} ${57 - h * 0.6}, ${c + 6} ${57 - h * 0.45}, ${c + 5} 57 Z`}
      fill={fill}
    />
  );
  return (
    <WeaveTile size={size} label="Spit over the fire">
      <g transform="translate(-4 25) scale(0.82)">
        <Spit from={12} to={74} />
        {ROAST.map((c, k) => pixel(k, c, 14))}
      </g>
      {[20, 32, 44].map((c, k) => flame(c, k === 1 ? 16 : 12, DONENESS[2]))}
      {[20, 32, 44].map((c, k) => (
        <g key={c} transform={`translate(${c} 57) scale(0.55) translate(${-c} -57)`}>
          {flame(c, k === 1 ? 16 : 12, '#f6cf75')}
        </g>
      ))}
    </WeaveTile>
  );
}

/** One big pixel on the spit, going from raw to done across it. */
function SpitOne({ size = 64 }: MarkProps) {
  const id = useSvgId('one');
  return (
    <Svg size={size} label="One pixel on a spit">
      <defs>
        <linearGradient id={id} x1="0" x2="1">
          {DONENESS.map((c, k) => (
            <stop key={c} offset={k / (DONENESS.length - 1)} stopColor={c} />
          ))}
        </linearGradient>
      </defs>
      {diagonal(
        <>
          <Spit from={8} to={74} />
          <rect x="27" y="-15" width="30" height="30" rx="3" fill={`url(#${id})`} />
          <circle cx="42" cy="0" r="2.2" fill={STEEL} />
        </>,
        41,
      )}
    </Svg>
  );
}

/** The spit seen through a lens. */
function SpitLens({ size = 64 }: MarkProps) {
  return (
    <Svg size={size} label="Spit in a lens">
      <Lens r={30}>
        <g transform="scale(0.62) rotate(-45) translate(-45 0)">
          <Spit from={14} to={90} crank={false} />
          {ROAST.map((c, k) => pixel(k, c))}
        </g>
      </Lens>
    </Svg>
  );
}

// ——— 3. Lattice drumstick ———

/** Drawn along +x (meat at the origin, bone towards +x), turned to point up-left. */
const MEAT = 'M -19 0 C -19 -16, 3 -18, 12 -8 L 19 -4 L 19 4 L 12 8 C 3 18, -19 16, -19 0 Z';
/** Where the drumstick sits on the page: bone to the top left, meat to the bottom right. */
const MEAT_TRANSFORM = 'translate(37 37) rotate(225)';

/** A drumstick whose meat shows `skin` (local units, the meat about ±19 around the origin). */
function Drumstick({ skin, edge = '#6e3415', glint }: { skin: ReactNode; edge?: string; glint?: boolean }) {
  const id = useSvgId('meat');
  const bone = (fill: string, grow: number) => (
    <g>
      <line x1="17" y1="0" x2="31" y2="0" stroke={fill} strokeWidth={5.5 + 2 * grow} strokeLinecap="round" />
      <circle cx="32" cy="-3.6" r={4.2 + grow} fill={fill} />
      <circle cx="32" cy="3.6" r={4.2 + grow} fill={fill} />
    </g>
  );
  return (
    <g transform={MEAT_TRANSFORM}>
      <defs>
        <clipPath id={id}>
          <path d={MEAT} />
        </clipPath>
      </defs>
      {bone(edge, 1.5)}
      {bone(BONE, 0)}
      <path d={MEAT} fill={edge} />
      <g clipPath={`url(#${id})`}>{skin}</g>
      <path d={MEAT} fill="none" stroke={edge} strokeWidth="2.5" />
      {/* Light from the top left: along the meat's top edge (local +y is the page's top right, +x its top left). */}
      {glint && (
        <path
          d="M -9 11.4 C -3 12.2, 4 11, 9.3 7.5"
          fill="none"
          stroke="#fff"
          strokeOpacity="0.6"
          strokeWidth="2"
          strokeLinecap="round"
        />
      )}
    </g>
  );
}

/**
 * A lattice over the meat: square to the page, or on the bias (`bias`, 45° to the page).
 * The drumstick is turned 225°, so 45° in its frame is square on the page.
 */
const lattice = (weave: ReactNode, bias = false) => (
  <g transform={`rotate(${bias ? 0 : 45}) translate(-26 -26)`}>{weave}</g>
);

const pastry = (n = 6) => (
  <Weave n={n} size={52} thread={0.62} warp={() => '#e4a24f'} weft={() => '#cf8233'} shade={0.45} />
);

function DrumLattice({ size = 64 }: MarkProps) {
  return (
    <Svg size={size} label="Lattice drumstick">
      <Drumstick skin={lattice(pastry())} />
    </Svg>
  );
}

function DrumBayer({ size = 64 }: MarkProps) {
  return (
    <Svg size={size} label="Bayer drumstick">
      <Drumstick edge="#2a2624" skin={lattice(<Weave n={6} size={52} thread={0.66} shade={0.4} />)} />
    </Svg>
  );
}

/** The lattice browns from one side of the meat to the other. */
function DrumRamp({ size = 64 }: MarkProps) {
  const n = 6;
  return (
    <Svg size={size} label="Drumstick, raw to done">
      <Drumstick
        skin={lattice(
          <Weave
            n={n}
            size={52}
            thread={0.62}
            shade={0.4}
            warp={(j) => doneness(0.1 + (0.8 * j) / (n - 1))}
            weft={(i) => doneness(0.2 + (0.8 * i) / (n - 1))}
          />,
        )}
      />
    </Svg>
  );
}

/** Sensor colours where the lattice starts, browning to crust where it ends (3b and 3c). */
const bayerToDone = (n: number) => (
  <Weave
    n={n}
    size={52}
    thread={0.64}
    shade={0.4}
    warp={(j) => mix(BAYER.g, doneness(0.25 + 0.6 * (j / (n - 1))), j / (n - 1))}
    weft={(i) => mix(i % 2 ? BAYER.b : BAYER.r, doneness(0.4 + 0.6 * (i / (n - 1))), i / (n - 1))}
  />
);

function DrumBayerDone({ size = 64 }: MarkProps) {
  return (
    <Svg size={size} label="Drumstick, Bayer to done">
      <Drumstick edge="#4a2814" skin={lattice(bayerToDone(6))} />
    </Svg>
  );
}

function DrumBayerDoneBias({ size = 64 }: MarkProps) {
  return (
    <Svg size={size} label="Drumstick, Bayer to done, on the bias">
      <Drumstick edge="#4a2814" skin={lattice(bayerToDone(7), true)} />
    </Svg>
  );
}

/** A Bayer pattern drawn in the doneness scale: raw for red, done for blue, between for green. */
function DrumBayerTones({ size = 64 }: MarkProps) {
  return (
    <Svg size={size} label="Drumstick, Bayer in doneness tones">
      <Drumstick
        skin={lattice(
          <Weave
            n={6}
            size={52}
            thread={0.64}
            shade={0.4}
            warp={() => DONENESS[2]}
            weft={(i) => (i % 2 ? DONENESS[4] : DONENESS[0])}
          />,
        )}
      />
    </Svg>
  );
}

/** Bayer's colours, pulled half way to golden: still a sensor, closer to a roast. */
function DrumBayerWarm({ size = 64 }: MarkProps) {
  const warm = (c: string) => mix(c, DONENESS[2], 0.45);
  return (
    <Svg size={size} label="Drumstick, warm Bayer">
      <Drumstick
        edge="#4a2814"
        skin={lattice(
          <Weave
            n={6}
            size={52}
            thread={0.64}
            shade={0.4}
            warp={() => warm(BAYER.g)}
            weft={(i) => warm(i % 2 ? BAYER.b : BAYER.r)}
          />,
        )}
      />
    </Svg>
  );
}

/** On the spit: the two ideas together. */
function DrumSpit({ size = 64 }: MarkProps) {
  return (
    <Svg size={size} label="Drumstick on a spit">
      <g transform="translate(0 40)">
        <Spit from={5} to={61} />
      </g>
      <Drumstick skin={lattice(pastry())} />
      {/* The spit comes out the other side, over the meat. */}
      <line x1="54" y1="40" x2="61" y2="40" stroke={STEEL} strokeWidth="3" strokeLinecap="round" />
    </Svg>
  );
}

/** In a lens, the bone breaking out of the frame; the glint on the meat, not the glass. */
function DrumLens({ size = 64 }: MarkProps) {
  return (
    <Svg size={size} label="Drumstick in a lens">
      <Lens r={26} cx={36} cy={36} glint={false}>
        <circle r="30" fill="#3a2014" />
      </Lens>
      <g transform="translate(36 36) scale(0.78) translate(-37 -37)">
        <Drumstick skin={lattice(pastry(5))} glint />
      </g>
    </Svg>
  );
}

/** Fewer, flatter strips, no shadows: for the smallest sizes. */
function DrumChunky({ size = 64 }: MarkProps) {
  return (
    <Svg size={size} label="Drumstick, chunky lattice">
      <Drumstick
        edge="#8a4419"
        skin={lattice(<Weave n={4} size={52} thread={0.55} warp={() => CRUST} weft={() => GOLD} shade={0} />)}
      />
    </Svg>
  );
}

// ——— Round 4: 3c, 3d and 3j, with skins that look like a Bayer ———

type Channel = 'r' | 'g' | 'b';

/** RGGB: which colour the photosite at row `i`, column `j` sees. */
const channel = (i: number, j: number): Channel => (i % 2 ? (j % 2 ? 'b' : 'g') : j % 2 ? 'g' : 'r');

/**
 * Where a cell of an `n`×`n` skin is along the drumstick, 0 at the round end to 1 by the
 * bone. (The skin is turned 270° on the page by `lattice`: columns run towards the bone,
 * rows away from it.)
 */
const along = (i: number, j: number, n: number) => (j - i + n - 1) / (2 * (n - 1));

/** A Bayer drawn in the doneness scale: red a step rawer, blue a step more done, green between. */
const donenessBayer = (ch: Channel, t: number) =>
  doneness(0.12 + 0.7 * t + (ch === 'r' ? -0.22 : ch === 'b' ? 0.22 : 0));

/** Sensor colours at the round end, cooked by the bone. */
const cellBayerToDone = (ch: Channel, t: number) => {
  // Stays a sensor for the first part, then cooks: halfway mixes of blue and orange are grey.
  const w = Math.min(1, Math.max(0, (t - 0.2) / 0.65)) ** 0.8;
  return mix(BAYER[ch], doneness(0.35 + 0.6 * t), w);
};

/**
 * A Bayer mosaic of `n`×`n` photosites, colour per cell. `basket`: each cell is long the
 * way its thread would run (red and blue across, green down), so it reads as woven.
 */
function Mosaic({
  n,
  size = 52,
  color,
  gap = 0.1,
  basket = false,
  shade = 0.3,
}: {
  n: number;
  size?: number;
  color: (i: number, j: number) => string;
  gap?: number;
  basket?: boolean;
  shade?: number;
}) {
  const pitch = size / n;
  const g = pitch * gap;
  const cells: ReactNode[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = j * pitch;
      const y = i * pitch;
      const fill = color(i, j);
      if (!basket) {
        cells.push(
          <rect
            key={`${i}-${j}`}
            x={x + g}
            y={y + g}
            width={pitch - 2 * g}
            height={pitch - 2 * g}
            rx={pitch * 0.14}
            fill={fill}
          />,
        );
        continue;
      }
      const across = (i + j) % 2 === 0;
      const narrow = pitch * 0.2;
      const r = across
        ? { x: x + g * 0.5, y: y + narrow, width: pitch - g, height: pitch - 2 * narrow }
        : { x: x + narrow, y: y + g * 0.5, width: pitch - 2 * narrow, height: pitch - g };
      cells.push(
        <g key={`${i}-${j}`}>
          <rect {...r} rx={pitch * 0.12} fill={fill} />
          {shade > 0 &&
            (across ? (
              <rect
                x={r.x}
                y={r.y + r.height - pitch * 0.1}
                width={r.width}
                height={pitch * 0.1}
                fill="#000"
                opacity={shade}
              />
            ) : (
              <rect
                x={r.x + r.width - pitch * 0.1}
                y={r.y}
                width={pitch * 0.1}
                height={r.height}
                fill="#000"
                opacity={shade}
              />
            ))}
        </g>,
      );
    }
  }
  return <g>{cells}</g>;
}

/** A drumstick mark from a skin. */
function drum(label: string, skin: () => ReactNode, edge?: string) {
  return function DrumMark({ size = 64 }: MarkProps) {
    return (
      <Svg size={size} label={label}>
        <Drumstick skin={lattice(skin())} edge={edge} />
      </Svg>
    );
  };
}

const ROAST_EDGE = '#5a2c12';

// 3c: doneness only.
const CMosaic = drum('Drumstick, doneness Bayer mosaic', () => (
  <Mosaic n={6} color={(i, j) => donenessBayer(channel(i, j), along(i, j, 6))} />
));
const CBasket = drum('Drumstick, doneness Bayer basket', () => (
  <Mosaic n={6} basket color={(i, j) => donenessBayer(channel(i, j), along(i, j, 6))} />
));
const CTight = drum('Drumstick, doneness Bayer tight weave', () => (
  <Weave
    n={6}
    size={52}
    thread={0.88}
    shade={0.3}
    warp={(j) => donenessBayer('g', j / 5)}
    weft={(i) => donenessBayer(i % 2 ? 'b' : 'r', 1 - i / 5)}
  />
));
const CFine = drum('Drumstick, fine doneness Bayer', () => (
  <Mosaic n={8} gap={0.08} color={(i, j) => donenessBayer(channel(i, j), along(i, j, 8))} />
));

// 3d: Bayer to done.
const DMosaic = drum(
  'Drumstick, Bayer to done mosaic',
  () => <Mosaic n={6} color={(i, j) => cellBayerToDone(channel(i, j), along(i, j, 6))} />,
  ROAST_EDGE,
);
const DBasket = drum(
  'Drumstick, Bayer to done basket',
  () => <Mosaic n={6} basket color={(i, j) => cellBayerToDone(channel(i, j), along(i, j, 6))} />,
  ROAST_EDGE,
);
const DTight = drum(
  'Drumstick, Bayer to done tight weave',
  () => (
    <Weave
      n={6}
      size={52}
      thread={0.88}
      shade={0.3}
      warp={(j) => cellBayerToDone('g', j / 5)}
      weft={(i) => cellBayerToDone(i % 2 ? 'b' : 'r', 1 - i / 5)}
    />
  ),
  ROAST_EDGE,
);
/** Only the round end is still a sensor: the rest is cooked. */
const DHalf = drum(
  'Drumstick, half cooked',
  () => (
    <Mosaic
      n={6}
      color={(i, j) => cellBayerToDone(channel(i, j), Math.min(1, Math.max(0, along(i, j, 6) * 1.8 - 0.3)))}
    />
  ),
  ROAST_EDGE,
);

// 3j: chunky, flat, for small sizes.
const JMosaic = drum(
  'Drumstick, chunky doneness Bayer',
  () => <Mosaic n={4} gap={0.07} color={(i, j) => donenessBayer(channel(i, j), along(i, j, 4))} />,
  '#8a4419',
);
const JBasket = drum(
  'Drumstick, chunky basket',
  () => <Mosaic n={4} basket shade={0} color={(i, j) => donenessBayer(channel(i, j), along(i, j, 4))} />,
  '#8a4419',
);
const JBayerDone = drum(
  'Drumstick, chunky Bayer to done',
  () => <Mosaic n={4} gap={0.07} color={(i, j) => cellBayerToDone(channel(i, j), along(i, j, 4))} />,
  ROAST_EDGE,
);
/** Crust colours only, three of them, flat: the closest to an emoji. */
const JCrust = drum(
  'Drumstick, chunky crust',
  () => <Mosaic n={4} gap={0.07} color={(i, j) => ({ r: CRUST, g: GOLD, b: DONENESS[3] })[channel(i, j)]} />,
  '#8a4419',
);

// ——— Round 5: 3d.2 refined ———

let meatTest: { ctx: CanvasRenderingContext2D; path: Path2D } | null = null;

/** Whether a point of the page (64 box) is in the meat. Browser only, like this page. */
function inMeat(x: number, y: number) {
  meatTest ??= { ctx: document.createElement('canvas').getContext('2d')!, path: new Path2D(MEAT) };
  // Undo the drumstick's transform: back to its own frame.
  const dx = x - 37;
  const dy = y - 37;
  const a = (-225 * Math.PI) / 180;
  return meatTest.ctx.isPointInPath(
    meatTest.path,
    dx * Math.cos(a) - dy * Math.sin(a),
    dx * Math.sin(a) + dy * Math.cos(a),
  );
}

/** How much of a cell is in the meat, 0 to 1, sampled. */
function coverage(x: number, y: number, p: number) {
  let n = 0;
  for (let a = 0; a < 6; a++)
    for (let b = 0; b < 6; b++) if (inMeat(x + ((a + 0.5) * p) / 6, y + ((b + 0.5) * p) / 6)) n++;
  return n / 36;
}

/** `cover`: how much of it is in the meat. */
type Cell = { x: number; y: number; i: number; j: number; cover: number };
const grids = new Map<string, Cell[]>();

/**
 * The photosites of pitch `p` over the meat, square to the page. The grid's offset is the
 * one that leaves the fewest slivers along the outline; cells mostly outside are left out.
 */
function meatGrid(p: number, keep = 0.45) {
  const known = grids.get(`${p}/${keep}`);
  if (known) return known;
  let best: { score: number; cells: Cell[] } | null = null;
  for (let ox = 0; ox < p; ox += p / 8) {
    for (let oy = 0; oy < p; oy += p / 8) {
      let score = 0;
      const cells: Cell[] = [];
      for (let i = 0; i * p + oy - p < 64; i++) {
        for (let j = 0; j * p + ox - p < 64; j++) {
          const x = ox + (j - 1) * p;
          const y = oy + (i - 1) * p;
          const c = coverage(x, y, p);
          if (c > 0.02 && c < 0.6) score += 1 - Math.abs(c - 0.3); // a sliver, or a cell that's lost
          if (c >= keep) cells.push({ x, y, i, j, cover: c });
        }
      }
      if (!best || score < best.score) best = { score, cells };
    }
  }
  grids.set(`${p}/${keep}`, best!.cells);
  return best!.cells;
}

/**
 * 3d.2 refined: the basket of photosites drawn on the page, every gap the same width, the
 * outline as wide as a gap and a half. `threads` shades each cell like a thread going
 * over (light on top, darker where it dives under), `volume` lights the meat from the top
 * left (a radial light, an inner shadow, a glint, a drop shadow), `grain` adds a crust.
 */
function RoastBasket({
  size = 64,
  pitch = 6.2,
  threads = false,
  volume = false,
  grain = false,
  pixelwise = false,
  gap,
  stretch = 0.045,
  strips = false,
}: MarkProps & {
  pitch?: number;
  threads?: boolean;
  volume?: boolean;
  grain?: boolean;
  pixelwise?: boolean;
  /** The gap between photosites, in 64ths of the mark. */
  gap?: number;
  /** How much longer a cell is the way its thread runs, as a fraction of the pitch. */
  stretch?: number;
  /** Cells reach into their neighbours' margins: crossing strips, gaps still even, small holes at the corners. */
  strips?: boolean;
}) {
  const id = useSvgId('roast');
  // Big cells get cut by the outline whatever the offset: keep more of them, or the edge goes bare.
  const cells = meatGrid(pitch, pitch > 8 ? 0.3 : 0.45);
  const line = gap ?? Math.max(0.6, pitch * 0.1);
  // Each cell only a little longer the way its thread runs: more, and the corners leave holes.
  const long = pitch * stretch;
  const reach = strips ? long : 0;
  // The bevel is about a 64th wide whatever the cell: in proportion, it's a band on big cells.
  const lit = Math.min(0.2, 1.1 / pitch);
  const shaded = Math.min(0.16, 0.9 / pitch);
  const edge = '#4a2410';
  // The gaps between photosites: a warmer brown than the outline, so the skin doesn't go dark.
  const grout = '#7a3a16';
  // Raw at the tip (top right), done by the bone (bottom left).
  // Raw at the tip (bottom right), done by the bone (top left).
  const tAt = (x: number, y: number) => Math.min(1, Math.max(0, (104 - x - y) / 54));
  const minI = Math.min(...cells.map((c) => c.i));
  const minJ = Math.min(...cells.map((c) => c.j));
  return (
    <Svg size={size} label="Drumstick, refined basket">
      <defs>
        <clipPath id={`${id}-meat`}>
          <path d={MEAT} transform={MEAT_TRANSFORM} />
        </clipPath>
        {/* Over a thread: lit on top (left for the green, which runs down), dark where it dives under. */}
        <linearGradient id={`${id}-across`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.4" />
          <stop offset={lit} stopColor="#fff" stopOpacity="0.4" />
          <stop offset={lit * 1.4} stopColor="#fff" stopOpacity="0" />
          <stop offset={1 - shaded * 1.4} stopColor="#000" stopOpacity="0" />
          <stop offset={1 - shaded} stopColor="#000" stopOpacity="0.22" />
          <stop offset="1" stopColor="#000" stopOpacity="0.22" />
        </linearGradient>
        <linearGradient id={`${id}-across-ends`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#000" stopOpacity="0.16" />
          <stop offset="0.12" stopColor="#000" stopOpacity="0" />
          <stop offset="0.88" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.16" />
        </linearGradient>
        <linearGradient id={`${id}-down`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0.4" />
          <stop offset={lit} stopColor="#fff" stopOpacity="0.4" />
          <stop offset={lit * 1.4} stopColor="#fff" stopOpacity="0" />
          <stop offset={1 - shaded * 1.4} stopColor="#000" stopOpacity="0" />
          <stop offset={1 - shaded} stopColor="#000" stopOpacity="0.22" />
          <stop offset="1" stopColor="#000" stopOpacity="0.22" />
        </linearGradient>
        <linearGradient id={`${id}-down-ends`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#000" stopOpacity="0.16" />
          <stop offset="0.12" stopColor="#000" stopOpacity="0" />
          <stop offset="0.88" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.16" />
        </linearGradient>
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
        <filter id={`${id}-grain`} x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="1.4" numOctaves="2" seed="7" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
      </defs>
      <g filter={volume ? `url(#${id}-shadow)` : undefined}>
        {/* The bone, outlined in the edge colour, lit like the rest when there's volume. */}
        <g transform={MEAT_TRANSFORM}>
          <rect x="15" y={-2.75 - line} width="17" height={5.5 + 2 * line} fill={edge} />
          <circle cx="32" cy="-3.6" r={4.2 + line} fill={edge} />
          <circle cx="32" cy="3.6" r={4.2 + line} fill={edge} />
          <rect x="15" y="-2.75" width="17" height="5.5" fill={volume ? `url(#${id}-bone)` : BONE} />
          <circle cx="32" cy="-3.6" r="4.2" fill={volume ? `url(#${id}-bone)` : BONE} />
          <circle cx="32" cy="3.6" r="4.2" fill={volume ? `url(#${id}-bone)` : BONE} />
          <path d={MEAT} fill={grout} />
        </g>
        <g clipPath={`url(#${id}-meat)`}>
          {cells.map(({ x, y, i, j, cover }) => {
            const ch = channel(i - minI, j - minJ);
            const across = ch !== 'g';
            const t = tAt(x + pitch / 2, y + pitch / 2);
            const fill = pixelwise ? cookedOrRaw(ch, t, i, j) : cellBayerToDone(ch, t);
            const r = across
              ? {
                  x: x + line / 2 - reach,
                  y: y + line / 2 + long,
                  width: pitch - line + 2 * reach,
                  height: pitch - line - 2 * long,
                }
              : {
                  x: x + line / 2 + long,
                  y: y + line / 2 - reach,
                  width: pitch - line - 2 * long,
                  height: pitch - line + 2 * reach,
                };
            const kind = across ? 'across' : 'down';
            return (
              <g key={`${i}-${j}`}>
                <rect {...r} rx={pitch * 0.13} fill={fill} />
                {/* No bevel on cells mostly under the outline: their lit edge shows as a stray bar. */}
                {threads && cover > 0.6 && <rect {...r} rx={pitch * 0.13} fill={`url(#${id}-${kind})`} />}
                {threads && <rect {...r} rx={pitch * 0.13} fill={`url(#${id}-${kind}-ends)`} />}
              </g>
            );
          })}
          {grain && (
            <rect
              x="12"
              y="12"
              width="52"
              height="52"
              filter={`url(#${id}-grain)`}
              opacity="0.22"
              style={{ mixBlendMode: 'overlay' }}
            />
          )}
          {volume && (
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
        <path d={MEAT} transform={MEAT_TRANSFORM} fill="none" stroke={edge} strokeWidth={line * 1.6} />
        {volume && (
          <g transform={MEAT_TRANSFORM}>
            <path
              d="M -9 11.6 C -3 12.4, 4 11.2, 9.5 7.6"
              fill="none"
              stroke="#fff"
              strokeOpacity="0.7"
              strokeWidth="1.6"
              strokeLinecap="round"
              filter={`url(#${id}-soft)`}
            />
          </g>
        )}
      </g>
    </Svg>
  );
}

/**
 * Pixel by pixel: a cell is either a pure sensor colour or cooked, never between (blends
 * of blue and orange are grey). Cells cook in a scattered order, more of them towards the bone.
 */
function cookedOrRaw(ch: Channel, t: number, i: number, j: number) {
  const scatter = ((i * 7 + j * 13 + ((i * j) % 5) * 3) % 10) / 10;
  return t > 0.25 + scatter * 0.45 ? doneness(0.35 + 0.6 * t) : BAYER[ch];
}

const big = (props: Omit<Parameters<typeof RoastBasket>[0], 'size'>) =>
  function BigRoast({ size }: MarkProps) {
    return <RoastBasket size={size} gap={1} {...props} />;
  };
const Big10 = big({ pitch: 10 });
const Big10Volume = big({ pitch: 10, threads: true, volume: true });
const Big12 = big({ pitch: 12 });
const Big12Volume = big({ pitch: 12, threads: true, volume: true });
const Big12Pixels = big({ pitch: 12, pixelwise: true });
const Big12PixelsVolume = big({ pitch: 12, pixelwise: true, threads: true, volume: true });
const Strips12 = big({ pitch: 12, strips: true, stretch: 0.16 });
const Strips12Volume = big({ pitch: 12, strips: true, stretch: 0.16, threads: true, volume: true });
const Strips12Pixels = big({ pitch: 12, strips: true, stretch: 0.16, pixelwise: true, threads: true, volume: true });
const Big14 = big({ pitch: 14 });

const RoastEven = ({ size }: MarkProps) => <RoastBasket size={size} />;
const RoastThreads = ({ size }: MarkProps) => <RoastBasket size={size} threads />;
const RoastVolume = ({ size }: MarkProps) => <RoastBasket size={size} threads volume />;
const RoastGrain = ({ size }: MarkProps) => <RoastBasket size={size} threads volume grain />;
const RoastFine = ({ size }: MarkProps) => <RoastBasket size={size} pitch={5.2} threads volume />;
const RoastSmall = ({ size }: MarkProps) => <RoastBasket size={size} pitch={8} />;
const RoastPixels = ({ size }: MarkProps) => <RoastBasket size={size} threads volume pixelwise />;
const RoastPixelsFlat = ({ size }: MarkProps) => <RoastBasket size={size} pixelwise />;

// ——— The page ———

/** `fresh`: new in this round. */
type Variant = { name: string; note: ReactNode; Mark: (p: MarkProps) => ReactNode; fresh?: boolean };
/** `prefix`: how its variants are numbered (`3c.1`…), for the rounds that iterate on one. */
type Direction = {
  id: string;
  name: string;
  idea: ReactNode;
  variants: Variant[];
  prefix?: string;
  /** Show the marks bigger: for details. */
  large?: boolean;
  /** Start with a grid of every variant at small sizes. */
  compareSizes?: boolean;
};

/** This round: the favourites (3c, 3d, 3j), iterated. */
const FOCUS: Direction[] = [
  {
    id: 'bigger',
    prefix: '3d.2.',
    large: true,
    compareSizes: true,
    name: '3d.2 with 3j’s big photosites',
    idea: (
      <>
        3j’s chunky cells brought into the refined basket: photosites two to three times wider than in 3d.2.1–8 (a pitch
        of 10 to 14 64ths instead of 6), gaps of one 64th. “Strips” make the cells longer and let them reach into their
        neighbours’ margins, so they read as crossing threads like 3j’s lattice, the gaps still even, a small hole at
        each corner.
      </>
    ),
    variants: [
      { name: 'Pixel by pixel, flat', note: 'From the last round, for comparison.', Mark: RoastPixelsFlat },
      { name: '3j Bayer to done', note: 'Round 4’s chunky, for comparison.', Mark: JBayerDone },
      { name: 'Big', note: 'Pitch 10, flat.', Mark: Big10, fresh: true },
      { name: 'Big, volume', note: 'Pitch 10, threads and volume.', Mark: Big10Volume, fresh: true },
      { name: 'Bigger', note: 'Pitch 12, flat.', Mark: Big12, fresh: true },
      { name: 'Bigger, volume', note: 'Pitch 12, threads and volume.', Mark: Big12Volume, fresh: true },
      {
        name: 'Bigger, pixel by pixel',
        note: 'Pitch 12, raw or cooked per cell, flat.',
        Mark: Big12Pixels,
        fresh: true,
      },
      {
        name: 'Bigger, pixel by pixel, volume',
        note: 'Pitch 12, raw or cooked per cell, threads and volume.',
        Mark: Big12PixelsVolume,
        fresh: true,
      },
      { name: 'Strips', note: 'Pitch 12, cells long and crossing, flat.', Mark: Strips12, fresh: true },
      { name: 'Strips, volume', note: 'The strips with threads and volume.', Mark: Strips12Volume, fresh: true },
      {
        name: 'Strips, pixel by pixel',
        note: 'The strips, raw or cooked per cell, with volume.',
        Mark: Strips12Pixels,
        fresh: true,
      },
      { name: 'Biggest', note: 'Pitch 14, flat: about 3j’s size.', Mark: Big14, fresh: true },
    ],
  },
  {
    id: 'refined',
    prefix: '3d.2.',
    large: true,
    compareSizes: true,
    name: '3d.2 Basket, refined',
    idea: (
      <>
        Drawn again on the page rather than turned with the drumstick: every gap the same width and the outline about as
        wide, the grid placed so the fewest cells get cut into slivers by the outline (cells mostly outside are left
        out), pure sensor colours kept longer at the tip. Then, one layer at a time: each cell shaded like a thread
        going over and under, light on the meat from the top left with an inner shadow and a glint, a drop shadow, and a
        grain.
      </>
    ),
    variants: [
      { name: 'As it was', note: '3d.2, for comparison.', Mark: DBasket },
      {
        name: 'Even lines',
        note: 'Flat, as before, with even gaps and no sliver cells.',
        Mark: RoastEven,
      },
      {
        name: 'Threads',
        note: 'Each cell bevelled like a thread going over: a lit edge on top (left for green), a shade below, ends a little darker.',
        Mark: RoastThreads,
      },
      {
        name: 'Volume',
        note: 'Light from the top left, an inner shadow along the outline, a glint, a drop shadow, a shaded bone.',
        Mark: RoastVolume,
      },
      { name: 'Roasted', note: 'Volume and a fine grain, like a crust.', Mark: RoastGrain },
      {
        name: 'Pixel by pixel',
        note: 'No blends (blue into orange goes grey): each photosite is raw or cooked, scattered, more cooked by the bone.',
        Mark: RoastPixels,
      },
      { name: 'Pixel by pixel, flat', note: 'The same without the shading.', Mark: RoastPixelsFlat },
      { name: 'Finer', note: 'Volume with smaller photosites.', Mark: RoastFine },
      { name: 'For small sizes', note: 'Bigger photosites, flat: for 16 px.', Mark: RoastSmall },
    ],
  },
  {
    id: 'raw-to-done',
    prefix: '3c.',
    name: '3c Raw to done',
    idea: (
      <>
        The doneness scale only, now laid out as RGGB: in each 2×2 cell, red is a step rawer, blue a step more done,
        green between, the whole skin browning towards the bone.
      </>
    ),
    variants: [
      { name: 'As it was', note: 'Round 3’s lattice, for comparison.', Mark: DrumRamp },
      {
        name: 'Mosaic',
        note: 'Square photosites with thin gaps: reads as a sensor first.',
        Mark: CMosaic,
      },
      {
        name: 'Basket',
        note: 'Red and blue cells long across, green long down: a Bayer that still looks woven.',
        Mark: CBasket,
      },
      {
        name: 'Tight weave',
        note: 'Continuous threads, packed close, so the crossings form the grid.',
        Mark: CTight,
      },
      { name: 'Fine', note: 'Smaller photosites: more pattern, less legible small.', Mark: CFine },
    ],
  },
  {
    id: 'bayer-to-done',
    prefix: '3d.',
    name: '3d Bayer to done',
    idea: <>Sensor colours at the round end, browning to doneness by the bone: from raw to well done, literally.</>,
    variants: [
      { name: 'As it was', note: 'Round 3’s lattice, for comparison.', Mark: DrumBayerDone },
      {
        name: 'Mosaic',
        note: 'Square photosites, the ramp per cell rather than per thread.',
        Mark: DMosaic,
      },
      { name: 'Basket', note: 'The woven Bayer cells.', Mark: DBasket },
      { name: 'Tight weave', note: 'Continuous threads, packed close.', Mark: DTight },
      {
        name: 'Half cooked',
        note: 'A sharper turn: sensor at the tip, cooked from the middle on.',
        Mark: DHalf,
      },
    ],
  },
  {
    id: 'chunky',
    prefix: '3j.',
    name: '3j Chunky',
    idea: <>Few, flat cells, no shadows: the one that has to work at 16 px.</>,
    variants: [
      { name: 'As it was', note: 'Round 3’s chunky lattice, for comparison.', Mark: DrumChunky },
      { name: 'Doneness Bayer', note: 'Four by four photosites in the doneness scale.', Mark: JMosaic },
      { name: 'Basket', note: 'The woven cells, flat.', Mark: JBasket },
      { name: 'Bayer to done', note: 'Sensor colours at the tip, chunky.', Mark: JBayerDone },
      {
        name: 'Crust',
        note: 'Three crust colours in RGGB: the calmest, closest to an emoji.',
        Mark: JCrust,
      },
    ],
  },
];

const DIRECTIONS: Direction[] = [
  {
    id: 'woven',
    name: 'Woven sensor',
    idea: (
      <>
        Tisser, to weave. A Bayer sensor <em>is</em> a plain weave: green threads one way, red and blue the other, and
        what shows at the crossings is exactly RGGB, green twice as often because it's the warp.
      </>
    ),
    variants: [
      { name: 'Bayer', note: 'The first round’s: 4×4, sensor colours.', Mark: WovenBayer },
      { name: 'Toasted', note: 'Same weave in crust colours: food first.', Mark: WovenToasted },
      {
        name: 'Raw to done',
        note: 'Sensor colours at the top left, crust at the bottom right: the tagline in one tile.',
        Mark: WovenRamp,
      },
      { name: 'Two by two', note: 'One Bayer cell, thick threads: the favicon.', Mark: WovenChunky },
      { name: 'Loose threads', note: 'No tile, a scrap of fabric with raw edges.', Mark: WovenLoose },
      { name: 'Behind the lens', note: 'The sensor seen through the front element.', Mark: WovenLens },
      {
        name: 'On the bias',
        note: 'The weave turned 45° in its tile: diamonds of colour.',
        Mark: WovenBias,
      },
      {
        name: 'Raw to done, on the bias',
        note: 'The raw-to-done weave, turned 45°.',
        Mark: WovenBiasRamp,
      },
      {
        name: 'Diamond',
        note: 'The tile turned instead: threads square to the page.',
        Mark: WovenDiamond,
      },
      {
        name: 'Round, on the bias',
        note: 'A disc of it: a sensor, a lens, a pie.',
        Mark: WovenBiasCircle,
      },
      { name: 'Loose, on the bias', note: 'The scrap of fabric, turned.', Mark: WovenLooseBias },
    ],
  },
  {
    id: 'spit',
    name: 'Spit roast',
    idea: (
      <>
        Rôtisserie, literally: things on a spit, each turned a little more and cooked a little more, from raw to well
        done.
      </>
    ),
    variants: [
      { name: 'Pixels', note: 'The first round’s: three photosites on the diagonal.', Mark: SpitRoast },
      { name: 'Woven', note: 'The spit goes over and under them.', Mark: SpitWoven },
      {
        name: 'Optical axis',
        note: 'A lens is elements threaded on an axis: the optical axis as the spit, glass on it.',
        Mark: SpitOptical,
      },
      { name: 'Over the fire', note: 'In a tile, with flames: the most literal.', Mark: SpitFire },
      { name: 'One pixel', note: 'A single photosite going from raw to done across it.', Mark: SpitOne },
      { name: 'In a lens', note: 'The spit seen through a lens.', Mark: SpitLens },
    ],
  },
  {
    id: 'drumstick',
    name: 'Lattice drumstick',
    idea: (
      <>
        The 🍗 the app has today, its skin a lattice crust, which is a weave. The bone is outlined now, so it holds on
        white.
      </>
    ),
    variants: [
      { name: 'Lattice', note: 'The first round’s.', Mark: DrumLattice },
      { name: 'Bayer skin', note: 'The lattice in sensor colours: a drumstick made of photosites.', Mark: DrumBayer },
      { name: 'Raw to done', note: 'The lattice browns from one side to the other.', Mark: DrumRamp },
      {
        name: 'Bayer to done',
        note: '3b and 3c together: sensor colours where the lattice starts, crust where it ends.',
        Mark: DrumBayerDone,
      },
      {
        name: 'Bayer to done, on the bias',
        note: 'The same, the lattice at 45° to the page.',
        Mark: DrumBayerDoneBias,
      },
      {
        name: 'Bayer in doneness tones',
        note: 'RGGB drawn with the scale: raw for red, done for blue, golden for green.',
        Mark: DrumBayerTones,
      },
      {
        name: 'Warm Bayer',
        note: 'Sensor colours pulled half way to golden.',
        Mark: DrumBayerWarm,
      },
      { name: 'On the spit', note: 'Both ideas at once: skewered, crank on the left.', Mark: DrumSpit },
      {
        name: 'In a lens',
        note: 'Framed by a lens, the bone breaking out of it. The glint is on the meat now, following its edge.',
        Mark: DrumLens,
      },
      { name: 'Chunky', note: 'Fewer, flatter strips, for 16 px.', Mark: DrumChunky },
    ],
  },
];

/** The name next to a mark, `RAW` heavier: it's the half of the pun people miss. */
function Wordmark({ mark, color }: { mark: ReactNode; color: string }) {
  return (
    <HStack gap="2" color={color}>
      {mark}
      <Text fontFamily="heading" fontSize="19px" lineHeight="1" letterSpacing="-0.02em">
        <Box as="span" fontWeight="800">
          RAW
        </Box>
        <Box as="span" fontWeight="400">
          tisserie
        </Box>
      </Text>
    </HStack>
  );
}

function Strip({ Mark, bg, color }: { Mark: Variant['Mark']; bg: string; color: string }) {
  return (
    <HStack gap="3" align="end" bg={bg} borderRadius="md" px="3" py="2" justify="space-between">
      <Wordmark mark={<Mark size={26} />} color={color} />
      <HStack gap="2" align="end">
        <Mark size={16} />
        <Mark size={24} />
      </HStack>
    </HStack>
  );
}

function VariantCard({ variant, index, large }: { variant: Variant; index: string; large?: boolean }) {
  const { Mark } = variant;
  return (
    <Stack gap="3" bg="bg.panel" borderWidth="1px" borderRadius="lg" p="3">
      <Grid templateColumns="1fr 1fr" gap="2">
        <Box bg={DARK} borderRadius="md" p="3" display="grid" placeItems="center">
          <Mark size={large ? 208 : 104} />
        </Box>
        <Box bg={LIGHT} borderRadius="md" p="3" display="grid" placeItems="center">
          <Mark size={large ? 208 : 104} />
        </Box>
      </Grid>
      <Stack gap="0.5">
        <Text textStyle="sm" fontWeight="semibold">
          <Box as="span" color="fg.subtle" fontFamily="numeric" mr="1.5">
            {index}
          </Box>
          {variant.name}
          {variant.fresh && (
            <Box
              as="span"
              ml="2"
              px="1.5"
              py="0.5"
              borderRadius="sm"
              bg="bg.emphasized"
              textStyle="2xs"
              color="fg.muted"
            >
              new
            </Box>
          )}
        </Text>
        <Text textStyle="xs" color="fg.muted">
          {variant.note}
        </Text>
      </Stack>
      <Strip Mark={Mark} bg={DARK} color="#efe9e2" />
      <Strip Mark={Mark} bg={LIGHT} color="#26211d" />
    </Stack>
  );
}

/** One direction's variants. `number` heads it, and numbers its variants (`1a`, or `3c.1`). */
const SIZES = [16, 20, 24, 32, 48];

/** Every variant at the sizes it'll mostly be seen at, side by side, on dark and on light, and in a tab. */
function SizeGrid({ variants, index }: { variants: Variant[]; index: (j: number) => string }) {
  const cells = (bg: string, Mark: Variant['Mark']) => (
    <HStack bg={bg} px="4" py="2.5" gap="5" align="center" h="full">
      {SIZES.map((s) => (
        <Box key={s} w="48px" display="grid" placeItems="center">
          <Mark size={s} />
        </Box>
      ))}
    </HStack>
  );
  const sizeLabels = (
    <HStack px="4" gap="5">
      {SIZES.map((s) => (
        <Text key={s} w="48px" textAlign="center" textStyle="2xs" color="fg.subtle" fontFamily="numeric">
          {s}
        </Text>
      ))}
    </HStack>
  );
  return (
    <Box overflowX="auto">
      <Grid templateColumns="auto auto auto auto" columnGap="0" rowGap="1" alignItems="stretch" w="max-content">
        <Box />
        {sizeLabels}
        {sizeLabels}
        <Text textStyle="2xs" color="fg.subtle" px="4" alignSelf="end">
          tab
        </Text>
        {variants.map((v, j) => (
          <Fragment key={v.name}>
            <HStack gap="2" pr="4" textStyle="sm" whiteSpace="nowrap">
              <Box as="span" color="fg.subtle" fontFamily="numeric">
                {index(j)}
              </Box>
              <Text>{v.name}</Text>
            </HStack>
            <Box borderLeftRadius="md" overflow="hidden" borderWidth="1px" borderRightWidth="0" borderColor="border">
              {cells(DARK, v.Mark)}
            </Box>
            <Box borderRightRadius="md" overflow="hidden">
              {cells(LIGHT, v.Mark)}
            </Box>
            <Box px="4" display="flex" alignItems="end">
              <HStack
                gap="2"
                bg="#2c2a28"
                color="#e8e4df"
                px="3"
                py="1.5"
                borderTopRadius="md"
                fontSize="12px"
                fontFamily="body"
                w="40"
              >
                <v.Mark size={16} />
                <Text>RAWtisserie</Text>
              </HStack>
            </Box>
          </Fragment>
        ))}
      </Grid>
    </Box>
  );
}

function DirectionBlock({ direction: d, number }: { direction: Direction; number?: string }) {
  const index = (j: number) => (d.prefix ? `${d.prefix}${j}` : `${number}${String.fromCharCode(97 + j)}`);
  return (
    <Stack id={d.id} as="section" gap="5" py="8" borderBottomWidth="1px" scrollMarginTop="14">
      <Stack gap="1">
        <Heading size="xl">
          {!d.prefix && (
            <Box as="span" color="fg.subtle" fontFamily="numeric" mr="2">
              {number}
            </Box>
          )}
          {d.name}
        </Heading>
        <Text textStyle="sm" color="fg.muted" maxW="3xl">
          {d.idea}
        </Text>
      </Stack>
      {d.compareSizes && (
        <Stack gap="2" pb="4">
          <Text textStyle="xs" color="fg.muted" fontWeight="semibold" textTransform="uppercase" fontFamily="label">
            Small sizes, side by side
          </Text>
          <SizeGrid variants={d.variants} index={index} />
        </Stack>
      )}
      <Grid templateColumns={`repeat(auto-fill, minmax(${d.large ? 480 : 300}px, 1fr))`} gap="4">
        {d.variants.map((v, j) => (
          <VariantCard key={v.name} variant={v} index={index(j)} large={d.large} />
        ))}
      </Grid>
    </Stack>
  );
}

export function LogoPage() {
  return (
    <Box h="full" overflowY="auto" bg="bg">
      <Box position="sticky" top="0" zIndex="sticky" bg="bg.panel" borderBottomWidth="1px">
        <Container maxW="7xl" py="3">
          <HStack justify="space-between" wrap="wrap" gap="3">
            <HStack gap="5" wrap="wrap">
              <Heading size="md">🍗 Logo ideas</Heading>
              {FOCUS.map((d) => (
                <Link key={d.id} href={`#${d.id}`} textStyle="sm" color="fg.muted">
                  {d.name}
                </Link>
              ))}
              <Link href="#earlier" textStyle="sm" color="fg.subtle">
                Earlier rounds
              </Link>
            </HStack>
            <Link asChild textStyle="sm" color="fg.muted">
              <RouterLink to="/ui">Back to /ui</RouterLink>
            </Link>
          </HStack>
        </Container>
      </Box>
      <Container maxW="7xl" pb="16">
        <Stack gap="4" py="8" borderBottomWidth="1px">
          <Text textStyle="md" maxW="3xl">
            Sixth round: 3d.2 with 3j’s big photosites, then the fifth (3d.2 refined, shading added one layer at a
            time). Below it, round four (3c, 3d and 3j with skins that look like a Bayer), then the earlier rounds. New
            variants are marked “new”.
          </Text>
          <HStack gap="6" wrap="wrap">
            <Stack gap="1">
              <Text textStyle="2xs" color="fg.subtle" fontFamily="mono">
                doneness
              </Text>
              <HStack gap="1">
                {DONENESS.map((c) => (
                  <Box key={c} w="10" h="6" bg={c} borderRadius="sm" title={c} />
                ))}
              </HStack>
            </Stack>
            <Stack gap="1">
              <Text textStyle="2xs" color="fg.subtle" fontFamily="mono">
                warm Bayer
              </Text>
              <HStack gap="1">
                {[BAYER.r, BAYER.g, BAYER.b].map((c) => (
                  <Box key={c} w="10" h="6" bg={c} borderRadius="sm" title={c} />
                ))}
              </HStack>
            </Stack>
          </HStack>
        </Stack>
        {FOCUS.map((d) => (
          <DirectionBlock key={d.id} direction={d} number={d.prefix} />
        ))}
        <Heading id="earlier" size="2xl" pt="12" pb="2" color="fg.muted" scrollMarginTop="14">
          Earlier rounds
        </Heading>
        {DIRECTIONS.map((d, k) => (
          <DirectionBlock key={d.id} direction={d} number={`${k + 1}`} />
        ))}
      </Container>
    </Box>
  );
}
