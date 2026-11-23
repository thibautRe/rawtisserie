/**
 * Limits against unintended use (scripts, runaway clients, abuse of a hosted instance):
 * how fast the API may be called, and how many of each thing a user may keep. They're
 * defaults that real use doesn't reach, not plans: storage is `accounts/quota.ts`'s.
 * Anything new a user can create without a bound must get one here.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import { HttpError } from './errors.ts';

const byAddress = (request: FastifyRequest) => `ip:${request.ip}`;
const byUser = (request: FastifyRequest) => (request.user ? `user:${request.user.id}` : byAddress(request));

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Requests per key (the user when signed in, the address otherwise) and window. `api`
 * applies to every route without its own; the others are routes' `config.rateLimit`,
 * each route counted apart (its own store).
 * Behind a proxy, addresses are only right with `TRUST_PROXY` (see `config.ts`).
 */
export const RATE_LIMITS = {
  /** Every API route: 20 a second on average, well above a culling session or a drag. */
  api: { max: 1200, timeWindow: MINUTE },
  /** Password checks (scrypt is slow on purpose): per address. */
  login: { max: 10, timeWindow: MINUTE, keyGenerator: byAddress },
  signup: { max: 10, timeWindow: HOUR, keyGenerator: byAddress },
  passwordChange: { max: 10, timeWindow: MINUTE },
  /** Guessing invitation codes. */
  invitation: { max: 30, timeWindow: MINUTE, keyGenerator: byAddress },
  /** Browsers' reports, from anyone. */
  reports: { max: 60, timeWindow: MINUTE, keyGenerator: byAddress },
  /** Server-rendered loupe tiles: each one is work for the zoom worker. */
  zoomTiles: { max: 600, timeWindow: MINUTE },
  /**
   * Each of the chunked upload's routes (`photos/uploads.ts`), apart from the rest: an
   * import to a server next door sends files as fast as a card reads (a RAW file is six
   * requests: 20 a second at 90 MB/s). 8 MiB chunks: 400 MB/s. The app waits when told.
   */
  uploads: { max: 3000, timeWindow: MINUTE },
} as const;

/** How many of each a user may keep. */
export const MAX_COUNT = {
  /** Module presets and styles together. */
  presets: 1000,
  filterPresets: 200,
  exportPresets: 100,
  /** Removed (hidden) ones included: their tables stay stored. */
  luts: 500,
  /** Tags no photo has (`user_tags`, shortcuts included). */
  userTags: 5000,
  accessTokens: 50,
  instances: 50,
  collections: 10_000,
  /** Versions of one photo (duplicates). */
  versionsPerPhoto: 100,
  /** Chunked uploads started and not completed (the app sends one at a time). */
  openUploads: 20,
} as const;

/** The LUT tables a user's LUTs hold, hidden ones included (they don't count in the storage quota). */
export const MAX_LUT_BYTES = 2 * 1024 ** 3;

/**
 * The rate limits, before any route is registered (it's applied as routes are added).
 * Counted in memory: one server process. Image routes opt out (`config.rateLimit: false`):
 * a grid scrolled fast asks for hundreds of renders, which are only files.
 */
export async function rateLimits(app: FastifyInstance) {
  await app.register(fastifyRateLimit, {
    ...RATE_LIMITS.api,
    // After `authPlugin`'s onRequest, so that signed-in users are counted as themselves.
    hook: 'preHandler',
    keyGenerator: byUser,
    // Only the API: the web app's files are static.
    allowList: (request) => !request.url.startsWith('/api/'),
  });
}

/** Refuse to create one more of `what` when `count` is already at `max`. */
export function checkCount(count: number, max: number, what: string) {
  if (count >= max) throw new HttpError(403, `You can keep at most ${max} ${what}`);
}
