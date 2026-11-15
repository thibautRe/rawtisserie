/**
 * Imports that survive a reload (roadmap 8.2). Runs with files left to send are saved
 * in IndexedDB as they change; after a reload (or a crash, or the laptop sleeping
 * through it), the library offers to resume them. Where the browser kept handles to
 * what was picked (`PickedFrom`), the files are opened again with the user's
 * permission; elsewhere they pick the folder or the files again, matched by name, size
 * and modification time. A file half sent resumes where it stopped (`uploadId`).
 *
 * A run is offered once no tab has it: each tab holds a Web Lock per run (`runLock`).
 */
import { type ImportItem, type ImportRun, allRuns, runLock, subscribeRuns } from './imports.ts';
import { type PickedFile, sameFile } from './pickedFiles.ts';

const DB = 'rawtisserie-imports';
const STORE = 'runs';
/** Interrupted runs older than this aren't offered (their uploads are swept after a day). */
const KEEP_MS = 7 * 86_400_000;
const SAVE_DELAY = 500;

export const isPending = (i: ImportItem) => i.status === 'waiting' || i.status === 'uploading';

/** The files of an interrupted run found among `picked`, by item key. */
export function matchFiles(run: ImportRun, picked: readonly PickedFile[]): Map<string, File> {
  const found = new Map<string, File>();
  const byKey = new Map(picked.map((p) => [`${p.file.name}\0${p.file.size}\0${p.file.lastModified}`, p.file]));
  for (const i of run.items) {
    if (!isPending(i)) continue;
    const file = byKey.get(`${i.name}\0${i.size}\0${i.modified}`);
    if (file && sameFile(i, file)) found.set(i.key, file);
  }
  return found;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;
function openDb(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    if (!globalThis.indexedDB) return resolve(null);
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    // Private windows may refuse: imports then just don't survive a reload.
    req.onerror = () => resolve(null);
  });
  return dbPromise;
}

async function store<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, mode);
    const req = f(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req ? req.result : null);
    tx.onerror = tx.onabort = () => resolve(null);
  });
}

/** Saved without what only matters while it runs. */
const saved = (run: ImportRun): ImportRun => ({ ...run, items: run.items.map((i) => ({ ...i, sent: 0 })) });

let saving = false;
let timer: ReturnType<typeof setTimeout> | null = null;
/** What was last written, by run: unchanged runs aren't written again. */
const written = new Map<string, ImportRun | null>();

/** Save this tab's runs as they change (once per tab). */
export function startSaving() {
  if (saving) return;
  saving = true;
  subscribeRuns(() => {
    // A run that just finished goes at once: otherwise a reload now would offer it again.
    if (allRuns().some((r) => written.get(r.id) !== r && !r.items.some(isPending))) {
      if (timer) clearTimeout(timer);
      timer = null;
      void save();
      return;
    }
    timer ??= setTimeout(() => {
      timer = null;
      void save();
    }, SAVE_DELAY);
  });
}

async function save() {
  const changed = allRuns().filter((r) => written.get(r.id) !== r);
  if (!changed.length) return;
  for (const r of changed) written.set(r.id, r);
  await store('readwrite', (s) => {
    for (const r of changed) {
      if (r.items.some(isPending)) s.put(saved(r));
      else s.delete(r.id);
    }
  });
}

/** Runs interrupted before: with files left to send, not in a tab, not too old. */
export async function interruptedImports(): Promise<ImportRun[]> {
  const all = (await store<ImportRun[]>('readonly', (s) => s.getAll() as IDBRequest<ImportRun[]>)) ?? [];
  const held = new Set(((await globalThis.navigator?.locks?.query().catch(() => null))?.held ?? []).map((l) => l.name));
  const mine = new Set(allRuns().map((r) => r.id));
  const old = all.filter((r) => Date.now() - r.startedAt > KEEP_MS);
  if (old.length) await store('readwrite', (s) => old.forEach((r) => s.delete(r.id)));
  return all.filter((r) => !old.includes(r) && !mine.has(r.id) && !held.has(runLock(r.id)) && r.items.some(isPending));
}

/** Give up on an interrupted run: forgotten here, and its uploads on the server. */
export async function forgetImport(run: ImportRun) {
  await store('readwrite', (s) => s.delete(run.id));
  for (const i of run.items)
    if (isPending(i) && i.uploadId)
      void fetch(`/api/uploads/${i.uploadId}`, { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
}
