/**
 * Raw denoise models (roadmap 3.5), downloaded the first time a recipe uses one and
 * kept in the browser (Cache API): an id never names another file
 * (`scripts/fetch-denoise-models.sh`). Without the Cache API (plain HTTP), the HTTP
 * cache keeps them (the server says so), up to its size limits.
 */
const CACHE = 'denoise-models';

export async function fetchDenoiseModel(id: string): Promise<ArrayBuffer | null> {
  const url = `/api/denoise-models/${encodeURIComponent(id)}`;
  const cache = typeof caches === 'undefined' ? null : await caches.open(CACHE).catch(() => null);
  const hit = await cache?.match(url).catch(() => undefined);
  if (hit) {
    try {
      return await hit.arrayBuffer();
    } catch {
      // Unreadable: downloaded again below, which replaces it.
    }
  }
  const res = await fetch(url).catch(() => null);
  if (!res?.ok) return null;
  const bytes = await res.arrayBuffer();
  void cache
    ?.put(url, new Response(bytes.slice(0), { headers: { 'content-type': 'application/octet-stream' } }))
    .catch(() => {});
  return bytes;
}
