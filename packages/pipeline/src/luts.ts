/**
 * Creative LUTs (the `lut` module): the built-in ones, and the shape of a user's.
 *
 * A LUT is identified by the SHA-256 of its canonical form (`Clut::id` in Rust), which
 * recipes refer to. Built-in and uploaded LUTs share those ids: a user who uploaded a
 * LUT that later becomes built-in keeps theirs, under the same id.
 */

export interface BuiltinLut {
  id: string;
  name: string;
  /** What it does, in a few words. */
  description: string;
  /** Who made it, for the credits. */
  credit: string;
  /** No longer offered; kept for the recipes that use it. */
  retired?: boolean;
}

const RAWTHERAPEE_FILM =
  'RawTherapee Film Simulation Collection by Pat David, Pavlov Dmitry and Michael Ezra (CC BY-SA 4.0)';

/** The LUTs that ship with the app, in `packages/pipeline/luts/` (see its README). */
export const BUILTIN_LUTS: readonly BuiltinLut[] = [
  {
    id: 'c9807b260eb689d8b34bb770b0c91988d745f48e10f70700ba13aaa0336486d4',
    name: 'Vivid',
    description: 'Saturated and contrasty, every colour boosted',
    credit: RAWTHERAPEE_FILM,
  },
  {
    id: '93adbf9487440b88cffb01d9be8fa7076e0fcef4ac48a7238acbc01cb7a1945b',
    name: 'Sunlit',
    description: 'Contrasty, with warm yellows and greens',
    credit: RAWTHERAPEE_FILM,
  },
  {
    id: '615fe9507a39a58dbd6a7b44680d38b25f8ce4965f9c8d5713d3eabcf61abacd',
    name: 'Deep Sky',
    description: 'Strong cyan-leaning blues and reds',
    credit: RAWTHERAPEE_FILM,
  },
  {
    id: '25ebaf427c7fbc693954d910a7e28e1a7c70976f5521d26cfd7c6f325d86307d',
    name: 'Cool Slide',
    description: 'Clean and slightly cool, muted greens',
    credit: RAWTHERAPEE_FILM,
  },
  {
    id: '3b610da3a348a0d3d1b94427cfd6b04ec809e2baff6d793bdc3f5d2f10a57d3f',
    name: 'Rich Slide',
    description: 'Deep shadows, rich reds and magentas',
    credit: RAWTHERAPEE_FILM,
  },
];

export const isBuiltinLut = (id: string): boolean => BUILTIN_LUTS.some((l) => l.id === id);

/** A LUT id: lowercase hex SHA-256. */
export const LUT_ID = /^[0-9a-f]{64}$/;

/** One of the user's LUTs, as the API returns it. */
export interface UserLut {
  /** Of the user's copy (rename, delete). */
  id: string;
  /** Of the table: what recipes refer to. */
  lutId: string;
  name: string;
  /** Nodes along each axis. */
  size: number;
  bitDepth: number;
  createdAt: string;
}

/** Longest name of a user's LUT. */
export const LUT_NAME_MAX = 200;
/** Largest packed LUT the server accepts (a 144³ 16-bit table packs to well under this). */
export const LUT_MAX_BYTES = 64 * 1024 * 1024;

/** `name`, or `name (2)`, `name (3)`…: the first not in `taken`, ignoring case (names that differ only by case are confusing). */
export function freeLutName(name: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((n) => n.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) if (!used.has(`${name} (${n})`.toLowerCase())) return `${name} (${n})`;
}
