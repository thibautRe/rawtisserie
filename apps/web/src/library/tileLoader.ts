/**
 * Loads the loupe's zoom tiles: a few at a time, in the order asked (nearest the
 * centre first), dropping the ones no longer wanted, so that the server renders what's
 * on screen and not where the view was. Loaded tiles are kept as object URLs, the
 * least recently used released beyond `max`.
 */
export class TileLoader {
  private loaded = new Map<string, string>();
  private inflight = new Map<string, AbortController>();
  private queue: string[] = [];
  private onLoad: () => void;
  private max: number;
  private concurrency: number;

  constructor(onLoad: () => void, { max = 256, concurrency = 3 } = {}) {
    this.onLoad = onLoad;
    this.max = max;
    this.concurrency = concurrency;
  }

  /** The tile's object URL, if loaded. */
  get(url: string): string | undefined {
    const blob = this.loaded.get(url);
    if (blob) {
      this.loaded.delete(url);
      this.loaded.set(url, blob);
    }
    return blob;
  }

  /** Load these (and only these) tiles, in this order. */
  want(urls: string[]) {
    const wanted = new Set(urls);
    for (const [url, ac] of this.inflight) {
      if (!wanted.has(url)) {
        ac.abort();
        this.inflight.delete(url);
      }
    }
    this.queue = urls.filter((u) => !this.loaded.has(u) && !this.inflight.has(u));
    this.pump();
  }

  dispose() {
    this.want([]);
    for (const blob of this.loaded.values()) URL.revokeObjectURL(blob);
    this.loaded.clear();
  }

  private pump() {
    while (this.inflight.size < this.concurrency && this.queue.length) void this.load(this.queue.shift()!);
  }

  private async load(url: string) {
    const ac = new AbortController();
    this.inflight.set(url, ac);
    try {
      const res = await fetch(url, { credentials: 'same-origin', signal: ac.signal });
      if (res.ok) {
        const blob = await res.blob();
        if (!ac.signal.aborted) {
          this.loaded.set(url, URL.createObjectURL(blob));
          for (const [old, b] of this.loaded) {
            if (this.loaded.size <= this.max) break;
            URL.revokeObjectURL(b);
            this.loaded.delete(old);
          }
          this.onLoad();
        }
      }
    } catch {
      // Aborted, or offline: asked again on the next move.
    } finally {
      if (this.inflight.get(url) === ac) this.inflight.delete(url);
      this.pump();
    }
  }
}
