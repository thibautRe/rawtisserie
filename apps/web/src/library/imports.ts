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
import { formatBytes } from '../lib/format.ts';
import type { FileTags } from './fileTags.ts';
import type { Picked, PickedFile, PickedFrom } from './pickedFiles.ts';

export type ImportStatus = 'waiting' | 'uploading' | 'imported' | 'skipped' | 'failed';
/** Why a file wasn't imported (the server's `SkipKind`). */
export type SkipKind = 'unsupported' | 'tooLarge' | 'duplicate' | 'deleted' | 'quota';

export interface ImportItem {
  key: string;
  name: string;
  /** Inside what was picked (`DCIM/100MSDCF/DSC01234.ARW`), or the name. */
  path: string;
  size: number;
  /** The file's modification time (ms): with its name and size, finds it again after a reload. */
  modified: number;
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
  /** The upload on the server (`/api/uploads`): a retry resumes it where it stopped. */
  uploadId?: string;
  /** Tags, rating and label from its files (`fileTags.ts`), given to the version it creates. */
  fileTags?: FileTags;
}

export interface ImportRun {
  id: string;
  startedAt: number;
  /** The folder it's from, if one was picked alone. */
  label: string | null;
  /** Where its files came from, to open them again after a reload (`importQueue.ts`). */
  from: PickedFrom;
  items: ImportItem[];
  /** Nothing left to send (until a retry). */
  done: boolean;
}

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

// Leaving the app while files are being sent asks first (the rest of them would be lost).
globalThis.addEventListener?.('beforeunload', (e) => {
  if (running.size) e.preventDefault();
});

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

export interface ImportDeps {
  /** The user's storage now (files that can't fit aren't sent). */
  storage: () => Promise<StorageUsage | null>;
  /** The library changed: an import added photos. */
  refresh: () => void;
  /** A new run started (its toast shows it). */
  onStart: (run: ImportRun) => void;
}

/**
 * Import what was picked: added to the run still going, if any (same id), else a new
 * run. Returns the run's id. `known` (from `findKnown`) are listed as already in the
 * library, without being hashed or sent. `fileTags` (`readFileTags`) go to the versions
 * created.
 */
export function startImport(
  picked: Picked,
  deps: ImportDeps,
  known: ReadonlySet<PickedFile> = new Set(),
  from: PickedFrom = { kind: picked.label ? 'folder' : 'files', handles: null },
  fileTags: ReadonlyMap<PickedFile, FileTags> = new Map(),
): string {
  const refused = picked.refused.map((f): ImportItem => ({
    key: crypto.randomUUID(),
    name: f.file.name,
    path: f.path,
    size: 0,
    modified: f.file.lastModified,
    // Not sent at all (the server would refuse it after the upload).
    status: 'skipped',
    sent: 0,
    kind: 'unsupported',
    reason: 'Not a RAW file or an image we read',
  }));
  const items = picked.files.map((f): ImportItem => {
    const key = crypto.randomUUID();
    const item = { key, name: f.file.name, path: f.path, size: f.file.size, modified: f.file.lastModified, sent: 0 };
    if (known.has(f)) return { ...item, status: 'skipped', kind: 'duplicate', reason: 'Already in your library' };
    files.set(key, f.file);
    const tags = fileTags.get(f);
    return { ...item, status: 'waiting', ...(tags && { fileTags: tags }) };
  });
  const all = [...items, ...refused];
  const active = runs.findLast((r) => !r.done);
  if (active) {
    update(active.id, (r) => ({
      ...r,
      // Opened again only if all of it can be.
      from: {
        kind: r.from.kind === 'folder' || from.kind === 'folder' ? 'folder' : 'files',
        handles: r.from.handles && from.handles && [...r.from.handles, ...from.handles],
      },
      items: [...r.items, ...all],
    }));
    return active.id;
  }
  const run: ImportRun = {
    id: crypto.randomUUID(),
    startedAt: Date.now(),
    label: picked.label,
    from,
    items: all,
    done: false,
  };
  begin(run, deps);
  return run.id;
}

/** The lock a tab holds on each run it has: another tab doesn't offer to resume those. */
export const runLock = (runId: string) => `rawtisserie-import-${runId}`;

function begin(run: ImportRun, deps: ImportDeps) {
  runs = [...runs, run];
  emit();
  // Held as long as this tab is open.
  void globalThis.navigator?.locks?.request(runLock(run.id), () => new Promise(() => {}));
  deps.onStart(run);
  void process(run.id, deps);
}

/**
 * Go on with a run interrupted before (`importQueue.ts`), with its files found again
 * (`found`, by item key). What was being sent resumes; what wasn't found fails, to be
 * retried once it's there.
 */
export function resumeImport(saved: ImportRun, found: ReadonlyMap<string, File>, deps: ImportDeps) {
  const items = saved.items.map((i): ImportItem => {
    if (i.status !== 'waiting' && i.status !== 'uploading') return i;
    const file = found.get(i.key);
    if (!file) return { ...i, status: 'failed', sent: 0, reason: 'Not found when the import was resumed' };
    files.set(i.key, file);
    return { ...i, status: 'waiting', sent: 0 };
  });
  begin({ ...saved, items, done: false }, deps);
}

/** Runs of this tab (`importQueue.ts` saves them). */
export const allRuns = () => runs;
export const subscribeRuns = subscribe;

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
        const result = await upload(files.get(item.key)!, {
          importId: runId,
          allowDeleted: !!item.allowDeleted,
          uploadId: item.uploadId,
          fileTags: item.fileTags,
          onStart: (uploadId) => updateItem(runId, item.key, { uploadId }),
          onProgress: (sent) => updateItem(runId, item.key, { sent }),
        });
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

/** Most files asked about at once by name. */
const NAMED_BATCH = 5000;

/**
 * The files the library has already, found by name, size and modification time (no
 * hashing: see `/api/photos/check`). Those only in the trash aren't: importing them
 * brings them back. If the server can't be asked, none are (hashing still finds them).
 */
export async function findKnown(list: readonly PickedFile[]): Promise<Set<PickedFile>> {
  const known = new Set<PickedFile>();
  for (let at = 0; at < list.length; at += NAMED_BATCH) {
    const batch = list.slice(at, at + NAMED_BATCH);
    const res = await fetch('/api/photos/check', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        files: batch.map((f) => ({ name: f.file.name, size: f.file.size, modified: f.file.lastModified })),
      }),
    }).catch(() => null);
    if (!res?.ok) return known;
    const { named } = (await res.json()) as { named: { index: number; status: 'library' | 'trash' }[] };
    for (const n of named) if (n.status === 'library') known.add(batch[n.index]!);
  }
  return known;
}

interface UploadResult {
  created: Photo[];
  skipped: { filename: string; kind: SkipKind; reason: string }[];
}

/** Bytes sent at a time: a lost connection costs at most this much again. */
const CHUNK = 8 * 1024 * 1024;
/** Tries of a chunk before the file fails (waiting 1, 2, 4… s in between). */
const CHUNK_TRIES = 5;

class UploadError extends Error {
  status: number;
  /** What the server has, when it says (409). */
  offset: number | undefined;
  constructor(status: number, message: string, offset?: number) {
    super(message);
    this.status = status;
    this.offset = offset;
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as (T & { error?: string; offset?: number }) | null;
  if (!res.ok) throw new UploadError(res.status, json?.error ?? `Upload failed (${res.status})`, json?.offset);
  return json as T;
}

/** One chunk at `offset`, reporting the bytes sent (XHR: fetch can't). Resolves with the new offset. */
function putChunk(id: string, offset: number, chunk: Blob, onProgress: (sent: number) => void) {
  return new Promise<number>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/uploads/${id}`);
    xhr.responseType = 'json';
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.setRequestHeader('upload-offset', String(offset));
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      const body = xhr.response as { offset?: number; error?: string } | null;
      if (xhr.status >= 200 && xhr.status < 300 && typeof body?.offset === 'number') resolve(body.offset);
      else reject(new UploadError(xhr.status, body?.error ?? `Upload failed (${xhr.status})`, body?.offset));
    };
    xhr.onerror = () => reject(new UploadError(0, 'Upload failed: the connection was lost'));
    xhr.send(chunk);
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface UploadOptions {
  importId: string;
  allowDeleted: boolean;
  /** An upload started before, to resume. */
  uploadId?: string;
  fileTags?: FileTags;
  onStart: (uploadId: string) => void;
  onProgress: (sent: number) => void;
}

/**
 * One file through `/api/uploads`, in chunks: a chunk that fails is tried again from
 * what the server has, and an upload started before (`uploadId`) resumes where it
 * stopped. Answers like `POST /api/photos`.
 */
async function upload(file: File, o: UploadOptions): Promise<UploadResult> {
  let id = o.uploadId;
  let offset = 0;
  if (id) {
    const state = await call<{ offset: number }>('GET', `/api/uploads/${id}`).catch(() => null);
    if (state) offset = state.offset;
    else id = undefined;
  }
  if (!id) {
    const started = await call<{ id?: string; skipped?: UploadResult['skipped'][number] }>('POST', '/api/uploads', {
      // The name alone: from a folder, Chrome gives its path too.
      name: file.name,
      size: file.size,
      // With its name and size, finds it again without hashing (`/api/photos/check`).
      modified: file.lastModified,
      import: o.importId,
      allowDeleted: o.allowDeleted,
      // For the version it creates.
      ...(o.fileTags && {
        tags: o.fileTags.tags,
        rating: o.fileTags.rating,
        label: o.fileTags.label,
        flag: o.fileTags.rejected ? 'rejected' : undefined,
      }),
    });
    if (started.skipped) return { created: [], skipped: [started.skipped] };
    id = started.id!;
    o.onStart(id);
  }
  o.onProgress(offset);
  let failures = 0;
  while (offset < file.size) {
    const from = offset;
    try {
      offset = await putChunk(id, from, file.slice(from, from + CHUNK), (n) => o.onProgress(from + n));
      failures = 0;
    } catch (err) {
      if (!(err instanceof UploadError) || err.status === 404 || err.status === 413) throw err;
      // Not where the server is (a chunk that arrived though its answer was lost).
      if (err.status === 409 && err.offset !== undefined) {
        offset = err.offset;
        continue;
      }
      if (++failures >= CHUNK_TRIES) throw err;
      await wait(1000 * 2 ** (failures - 1));
      // What arrived of the failed chunk is kept.
      offset = (await call<{ offset: number }>('GET', `/api/uploads/${id}`).catch(() => ({ offset: from }))).offset;
    }
    o.onProgress(offset);
  }
  return call<UploadResult>('POST', `/api/uploads/${id}/complete`);
}

/** For tests and the UI page: a run as it would be, without sending anything. */
export function sampleRun(items: Partial<ImportItem>[], done: boolean): ImportRun {
  return {
    id: 'sample',
    startedAt: Date.UTC(2026, 10, 14, 14, 2),
    label: null,
    from: { kind: 'files', handles: null },
    done,
    items: items.map((i, n) => ({
      key: `k${n}`,
      name: `DSC0${1000 + n}.ARW`,
      path: `DSC0${1000 + n}.ARW`,
      size: 42e6,
      modified: 0,
      status: 'waiting',
      sent: 0,
      ...i,
    })),
  };
}
