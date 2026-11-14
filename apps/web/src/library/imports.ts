/**
 * Importing files into the library (roadmap 8.2), app-wide rather than in the page that
 * started it: it goes on while the user browses elsewhere, the grid shows what's still
 * coming (`usePendingImports`), and the toast its progress and outcome (`ImportToast`).
 *
 * Each file is hashed in the browser a few files ahead of the upload, and the server is
 * asked which hashes it knows: files already in the library, or deleted for good before,
 * aren't sent at all. The upload checks again (another tab, or no hashing here). Every
 * version an import creates carries its id, so the library can show that import alone
 * (`?import=<id>`).
 */
import { useSyncExternalStore } from 'react';
import type { Photo, StorageUsage } from '../api/types.ts';
import { RAW_ACCEPT, formatBytes } from '../lib/format.ts';

export type ImportStatus = 'waiting' | 'uploading' | 'imported' | 'skipped' | 'failed';
/** Why a file wasn't imported (the server's `SkipKind`). */
export type SkipKind = 'unsupported' | 'tooLarge' | 'duplicate' | 'deleted' | 'quota';

export interface ImportItem {
  key: string;
  name: string;
  size: number;
  status: ImportStatus;
  /** Bytes sent, while uploading. */
  sent: number;
  kind?: SkipKind;
  /** Why it was skipped or failed. */
  reason?: string;
  /** The version created. */
  versionId?: string;
  /** Imported although it was deleted for good before ("Upload anyway"). */
  allowDeleted?: boolean;
}

export interface ImportRun {
  id: string;
  startedAt: number;
  items: ImportItem[];
  /** Nothing left to send (until a retry). */
  done: boolean;
}

/** What's left of a run to upload: its pending cards. */
export const pendingItems = (run: ImportRun | null) =>
  run ? run.items.filter((i) => i.status === 'waiting' || i.status === 'uploading') : [];

/** A run's outcome so far, by what happened to each file. */
export function summarize(run: ImportRun) {
  const of = (f: (i: ImportItem) => boolean) => run.items.filter(f);
  const totalBytes = run.items.reduce((s, i) => s + i.size, 0);
  const sentBytes = run.items.reduce(
    (s, i) => s + (i.status === 'uploading' ? i.sent : i.status === 'waiting' ? 0 : i.size),
    0,
  );
  return {
    total: run.items.length,
    finished: of((i) => i.status !== 'waiting' && i.status !== 'uploading').length,
    totalBytes,
    sentBytes,
    imported: of((i) => i.status === 'imported'),
    duplicates: of((i) => i.kind === 'duplicate'),
    deleted: of((i) => i.kind === 'deleted'),
    failed: of((i) => i.status === 'failed'),
    /** Not imported for another reason (not a RAW file, too large, storage full). */
    refused: of((i) => i.kind === 'unsupported' || i.kind === 'tooLarge' || i.kind === 'quota'),
  };
}

// ── The store ───────────────────────────────────────────────────────────────

/** Runs by id, the latest last. Kept for the tab's life (the toast refers to them). */
let runs: ImportRun[] = [];
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));
const emit = () => listeners.forEach((l) => l());

/** The files themselves, kept for retries, by item key. */
const files = new Map<string, File>();
const running = new Set<string>();

function update(runId: string, f: (run: ImportRun) => ImportRun) {
  runs = runs.map((r) => (r.id === runId ? f(r) : r));
  emit();
}
const updateItem = (runId: string, key: string, patch: Partial<ImportItem>) =>
  update(runId, (r) => ({ ...r, items: r.items.map((i) => (i.key === key ? { ...i, ...patch } : i)) }));

export const getRun = (id: string) => runs.find((r) => r.id === id) ?? null;

/** A run, kept up to date. */
export function useImportRun(id: string | null) {
  return useSyncExternalStore(subscribe, () => (id ? getRun(id) : null));
}

/** The run still sending files, if any. */
export function useActiveImport() {
  return useSyncExternalStore(subscribe, () => runs.findLast((r) => !r.done) ?? null);
}

export interface ImportDeps {
  /** The user's storage now (files that can't fit aren't sent). */
  storage: () => Promise<StorageUsage | null>;
  /** The library changed: an import added photos. */
  refresh: () => void;
  /** A new run started (its toast shows it). */
  onStart: (run: ImportRun) => void;
}

/**
 * Import `list`: added to the run still going, if any (same id), else a new run. Returns
 * the run's id.
 */
export function startImport(list: File[], deps: ImportDeps): string {
  const items = list.map((file): ImportItem => {
    const key = crypto.randomUUID();
    // Not sent at all (the server would refuse it after the upload).
    if (!isRaw(file.name))
      return {
        key,
        name: file.name,
        size: 0,
        status: 'skipped',
        sent: 0,
        kind: 'unsupported',
        reason: 'Not a supported RAW file',
      };
    files.set(key, file);
    return { key, name: file.name, size: file.size, status: 'waiting', sent: 0 };
  });
  const active = runs.findLast((r) => !r.done);
  if (active) {
    update(active.id, (r) => ({ ...r, items: [...r.items, ...items] }));
    return active.id;
  }
  const run: ImportRun = { id: crypto.randomUUID(), startedAt: Date.now(), items, done: false };
  runs = [...runs, run];
  emit();
  deps.onStart(run);
  void process(run.id, deps);
  return run.id;
}

/** Send the failed files of a run again. */
export const retryFailed = (runId: string, deps: ImportDeps) => requeue(runId, (i) => i.status === 'failed', {}, deps);

/** Import the files of a run that were deleted for good before, after all. */
export const uploadDeleted = (runId: string, deps: ImportDeps) =>
  requeue(runId, (i) => i.kind === 'deleted', { allowDeleted: true }, deps);

function requeue(runId: string, which: (i: ImportItem) => boolean, patch: Partial<ImportItem>, deps: ImportDeps) {
  update(runId, (r) => ({
    ...r,
    done: false,
    items: r.items.map((i) =>
      which(i) ? { ...i, ...patch, status: 'waiting', sent: 0, kind: undefined, reason: undefined } : i,
    ),
  }));
  if (!running.has(runId)) void process(runId, deps);
}

// ── Sending ─────────────────────────────────────────────────────────────────

/** Files hashed ahead of the one uploading. */
const LOOKAHEAD = 3;
/** Most hashes asked about at once. */
const CHECK_BATCH = 100;
const REFRESH_MS = 1500;

const RAW_EXTENSIONS = new Set(RAW_ACCEPT.split(','));
const isRaw = (name: string) => RAW_EXTENSIONS.has(name.slice(name.lastIndexOf('.')).toLowerCase());

async function process(runId: string, deps: ImportDeps) {
  running.add(runId);
  try {
    const usage = await deps.storage().catch(() => null);
    let used = usage?.used ?? 0;
    const hashes = new Map<string, Promise<string | null>>();
    /** What the server said about each hash asked about (null: nothing known). */
    const known = new Map<string, KnownStatus | null>();
    let hashing: Promise<unknown> = Promise.resolve();
    const hashOf = (key: string) => {
      let h = hashes.get(key);
      if (!h) {
        // One at a time, in order: a file's bytes are only in memory while it's hashed.
        h = hashing.then(() => sha256(files.get(key)!));
        hashing = h;
        hashes.set(key, h);
      }
      return h;
    };
    // The grid shows each photo as it's imported, refreshed at most every REFRESH_MS.
    let refreshed = 0;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const refreshSoon = () => {
      if (refreshTimer) return;
      refreshTimer = setTimeout(
        () => {
          refreshTimer = null;
          refreshed = Date.now();
          deps.refresh();
        },
        Math.max(0, refreshed + REFRESH_MS - Date.now()),
      );
    };

    for (;;) {
      const run = getRun(runId);
      const at = run?.items.findIndex((i) => i.status === 'waiting') ?? -1;
      if (!run || at < 0) break;
      const item = run.items[at]!;
      const ahead = run.items.slice(at, at + 1 + LOOKAHEAD).filter((i) => i.status === 'waiting');
      for (const i of ahead) void hashOf(i.key);

      const sha = await hashOf(item.key);
      if (sha && !known.has(sha)) {
        // This one and those hashed after it, in one request.
        const ready = await Promise.all(
          run.items
            .slice(at, at + CHECK_BATCH)
            .filter((i) => i.status === 'waiting' && hashes.has(i.key))
            .map((i) => hashes.get(i.key)!),
        );
        const ask = [...new Set(ready.filter((h): h is string => !!h && !known.has(h)))];
        const found = await checkHashes(ask).catch(() => null);
        if (found) for (const h of ask) known.set(h, found.get(h) ?? null);
      }
      const status = sha ? known.get(sha) : null;
      if (status?.status === 'library') {
        updateItem(runId, item.key, {
          status: 'skipped',
          kind: 'duplicate',
          reason: `Already in your library as ${status.filename}`,
        });
        continue;
      }
      if (status?.status === 'deleted' && !item.allowDeleted) {
        updateItem(runId, item.key, { status: 'skipped', kind: 'deleted', reason: 'You deleted this file before' });
        continue;
      }
      // A file only in the trash is stored already, but needs a new version: sent anyway.
      if (usage && usage.quota !== null && status?.status !== 'trash' && used + item.size > usage.quota) {
        updateItem(runId, item.key, {
          status: 'skipped',
          kind: 'quota',
          // Worded like the server's refusal.
          reason: `Not enough storage: ${formatBytes(used)} of ${formatBytes(usage.quota)} used`,
        });
        continue;
      }

      updateItem(runId, item.key, { status: 'uploading', sent: 0 });
      try {
        const result = await upload(files.get(item.key)!, runId, !!item.allowDeleted, (sent) =>
          updateItem(runId, item.key, { sent }),
        );
        const created = result.created[0];
        const skipped = result.skipped[0];
        if (created) {
          used += item.size;
          updateItem(runId, item.key, { status: 'imported', versionId: created.id });
          // The same file again in this import is a duplicate now.
          if (sha) known.set(sha, { status: 'library', filename: item.name });
          refreshSoon();
        } else if (skipped) {
          updateItem(runId, item.key, { status: 'skipped', kind: skipped.kind, reason: skipped.reason });
        } else {
          updateItem(runId, item.key, { status: 'failed', reason: 'The server didn’t say what happened' });
        }
      } catch (err) {
        updateItem(runId, item.key, { status: 'failed', reason: err instanceof Error ? err.message : 'Upload failed' });
      }
    }
    if (refreshTimer) clearTimeout(refreshTimer);
    deps.refresh();
  } finally {
    running.delete(runId);
    update(runId, (r) => ({ ...r, done: !r.items.some((i) => i.status === 'waiting') }));
    // Files are kept only while they may be sent again.
    for (const i of getRun(runId)?.items ?? [])
      if (i.status === 'imported' || i.kind === 'duplicate' || i.kind === 'unsupported') files.delete(i.key);
    // Files requeued as it finished.
    if (getRun(runId)?.items.some((i) => i.status === 'waiting')) void process(runId, deps);
  }
}

/** The file's SHA-256 (hex), or null when it can't be hashed here (then the server checks). */
async function sha256(file: File): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  try {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
    return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

interface KnownStatus {
  status: 'library' | 'trash' | 'deleted';
  filename?: string;
}

async function checkHashes(hashes: string[]): Promise<Map<string, KnownStatus>> {
  if (!hashes.length) return new Map();
  const res = await fetch('/api/photos/check', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hashes }),
  });
  if (!res.ok) throw new Error(res.statusText);
  const { files } = (await res.json()) as { files: (KnownStatus & { sha256: string })[] };
  return new Map(files.map((f) => [f.sha256, f]));
}

interface UploadResult {
  created: Photo[];
  skipped: { filename: string; kind: SkipKind; reason: string }[];
}

/** One file to `POST /api/photos`, reporting the bytes sent (XHR: fetch can't). */
function upload(file: File, runId: string, allowDeleted: boolean, onProgress: (sent: number) => void) {
  return new Promise<UploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const params = new URLSearchParams({ import: runId });
    if (allowDeleted) params.set('allowDeleted', 'true');
    xhr.open('POST', `/api/photos?${params}`);
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response as UploadResult);
      else reject(new Error((xhr.response as { error?: string } | null)?.error ?? `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Upload failed: the connection was lost'));
    const form = new FormData();
    form.append('files', file);
    xhr.send(form);
  });
}

/** For tests and the UI page: a run as it would be, without sending anything. */
export function sampleRun(items: Partial<ImportItem>[], done: boolean): ImportRun {
  return {
    id: 'sample',
    startedAt: Date.UTC(2026, 10, 14, 14, 2),
    done,
    items: items.map((i, n) => ({
      key: `k${n}`,
      name: `DSC0${1000 + n}.ARW`,
      size: 42e6,
      status: 'waiting',
      sent: 0,
      ...i,
    })),
  };
}
