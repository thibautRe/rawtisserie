/**
 * Photos' original files, kept in the browser (Cache API) so opening one again doesn't
 * download it again. The HTTP cache can't be relied on for that: Firefox keeps nothing
 * over 50 MB there, and many RAW files are bigger. An original's URL never changes, so
 * there's nothing to invalidate; the least recently used ones go past `budget()`.
 *
 * The cache belongs to the signed-in user (`setOriginalsUser`), and is dropped when
 * someone else signs in or they log out (`clearOriginals`). Without a user, or where the Cache API isn't
 * available (plain HTTP), originals are downloaded every time.
 */
import { fetchBytes } from './client.ts';

const PREFIX = 'originals:';
/** At most this much, and at most a third of what the browser lets the site store. */
const MAX_BYTES = 4 * 1024 ** 3;
const USED_KEY = 'originals.used';

let user: string | null = null;

const cacheName = (id: string) => PREFIX + id;
const available = () => typeof caches !== 'undefined';

/**
 * Who is signed in: their originals are kept, anyone else's are dropped. Null (signed
 * out, or the session expired) keeps them for when the same user signs in again.
 */
export function setOriginalsUser(id: string | null) {
  if (id === user) return;
  user = id;
  if (id) dropAllBut(id);
}

/** Drop every user's originals (signing out). */
export function clearOriginals() {
  user = null;
  dropAllBut(null);
}

function dropAllBut(id: string | null) {
  if (!id) writeUsed({});
  if (!available()) return;
  void caches
    .keys()
    .then((names) =>
      Promise.all(
        names.filter((n) => n.startsWith(PREFIX) && n !== (id && cacheName(id))).map((n) => caches.delete(n)),
      ),
    )
    .catch(() => {});
}

export interface FetchOriginalOptions {
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** Keep it once downloaded (default). False for a one-off, like exporting many photos. */
  keep?: boolean;
}

/** An original's bytes: from the browser's copy when there is one, else downloaded. */
export async function fetchOriginal(
  url: string,
  { onProgress, signal, keep = true }: FetchOriginalOptions = {},
): Promise<ArrayBuffer> {
  const name = user && available() ? cacheName(user) : null;
  const cache = name ? await caches.open(name).catch(() => null) : null;
  const hit = await cache?.match(url).catch(() => undefined);
  if (hit) {
    try {
      const bytes = await hit.arrayBuffer();
      touch(url);
      onProgress?.(1);
      return bytes;
    } catch {
      // Unreadable: downloaded again below, which replaces it.
    }
  }
  // Not in the HTTP cache as well: it would only be a second copy.
  const bytes = await fetchBytes(url, onProgress, signal, cache ? 'no-store' : undefined);
  if (cache && keep) {
    // The response copies the bytes now, so the caller may transfer `bytes` meanwhile.
    const stored = new Response(bytes, { headers: { 'content-length': String(bytes.byteLength) } });
    void cache
      .put(url, stored)
      .then(() => {
        touch(url);
        return trim(cache);
      })
      .catch(() => trim(cache).catch(() => {}));
  }
  return bytes;
}

/** Where a denoised photo of `url` named `key` (`denoiseKeyName`) is kept in the cache. */
function denoisedUrl(url: string, key: string): string {
  const u = new URL(url, location.href);
  u.searchParams.set('denoised', key);
  return u.href;
}

/** The original `url` a cache entry is for (itself, or the one it's a denoised photo of). */
function originalOf(entry: string): string {
  const u = new URL(entry);
  u.searchParams.delete('denoised');
  return u.href;
}

/**
 * A denoised photo of the original at `url` (roadmap 3.5), kept by `keepDenoised`,
 * or null. It opens without the RAW file.
 */
export async function fetchDenoised(url: string, key: string): Promise<ArrayBuffer | null> {
  const name = user && available() ? cacheName(user) : null;
  const cache = name ? await caches.open(name).catch(() => null) : null;
  const entry = denoisedUrl(url, key);
  const hit = await cache?.match(entry).catch(() => undefined);
  if (!hit) return null;
  try {
    const bytes = await hit.arrayBuffer();
    touch(entry);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Keep a denoised photo of the original at `url` in its place: the RAW file and other
 * denoised photos of it go (a recipe that needs them downloads the original again).
 * Counted in the same budget.
 */
export function keepDenoised(url: string, key: string, file: ArrayBuffer) {
  const name = user && available() ? cacheName(user) : null;
  if (!name) return;
  const entry = denoisedUrl(url, key);
  const original = new URL(url, location.href).href;
  void (async () => {
    const cache = await caches.open(name);
    await cache.put(entry, new Response(file, { headers: { 'content-length': String(file.byteLength) } }));
    touch(entry);
    const others = (await cache.keys()).filter((r) => r.url !== entry && originalOf(r.url) === original);
    await Promise.all(others.map((r) => cache.delete(r)));
    await trim(cache);
  })().catch(() => {});
}

export interface CachedOriginal {
  url: string;
  size: number;
  /** When it was last opened (ms), 0 when unknown: those go first. */
  usedAt: number;
}

/** Which originals to drop for the rest to fit in `budget` bytes: the least recently used. */
export function evictions(entries: CachedOriginal[], budget: number): string[] {
  let total = entries.reduce((sum, e) => sum + e.size, 0);
  const out: string[] = [];
  for (const e of [...entries].sort((a, b) => a.usedAt - b.usedAt)) {
    if (total <= budget) break;
    out.push(e.url);
    total -= e.size;
  }
  return out;
}

async function budget() {
  const quota = (await navigator.storage?.estimate?.().catch(() => null))?.quota;
  return quota ? Math.min(MAX_BYTES, quota / 3) : MAX_BYTES;
}

let trimming: Promise<void> | null = null;

/** Drop the least recently used originals past the budget (one pass at a time). */
function trim(cache: Cache): Promise<void> {
  trimming ??= (async () => {
    const used = readUsed();
    const requests = await cache.keys();
    const entries = await Promise.all(
      requests.map(async (req) => {
        const res = await cache.match(req);
        return { url: req.url, size: Number(res?.headers.get('content-length')) || 0, usedAt: used[req.url] ?? 0 };
      }),
    );
    const gone = new Set(evictions(entries, await budget()));
    await Promise.all([...gone].map((url) => cache.delete(url)));
    // Only those still kept: the others were dropped, or another user's.
    writeUsed(Object.fromEntries(entries.filter((e) => !gone.has(e.url) && e.usedAt).map((e) => [e.url, e.usedAt])));
  })().finally(() => (trimming = null));
  return trimming;
}

/** When each original was last opened, by absolute URL (as `cache.keys()` gives them). */
function readUsed(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(USED_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function writeUsed(used: Record<string, number>) {
  try {
    localStorage.setItem(USED_KEY, JSON.stringify(used));
  } catch {
    // Not remembered: the oldest stored go first instead.
  }
}

function touch(url: string) {
  const used = readUsed();
  used[new URL(url, location.href).href] = Date.now();
  writeUsed(used);
}
