/**
 * Export from the library (roadmap 8.4): one photo or a selection, rendered in the
 * browser one at a time, delivered as one ZIP (a single photo as its file). The run
 * lives outside any page, so going to the developer and back doesn't stop it; the
 * progress panel (`ExportProgress`) shows it.
 */
import {
  EXPORT_FORMATS,
  type EditParams,
  type ExportSettings,
  type PhotoMetadata,
  defaultRecipe,
  exportFilename,
  exportOptions,
  resolveAutoTunes,
} from '@rawtisserie/pipeline';
import { useSyncExternalStore } from 'react';
import { fetchBytes } from '../api/client.ts';
import type { Photo } from '../api/types.ts';
import { toaster } from '../components/toaster.tsx';
import { backendMeasures } from '../develop/autoTune.ts';
import { photoExportInfo } from '../develop/exportInfo.ts';
import { LocalRenderBackend } from '../develop/localRenderBackend.ts';
import { lutTable } from '../develop/luts.ts';
import { saveBlob } from '../lib/download.ts';
import { ZipWriter } from '../lib/zip.ts';
import { fetchRecipe } from '../library/batchEdit.ts';
import { archiveName, uniqueName } from './names.ts';

export interface ExportRun {
  total: number;
  /** Photos finished, exported or not. */
  done: number;
  exported: number;
  /** The file name of the photo being exported. */
  current: string | null;
  /** Photos that couldn't be exported, and why. */
  failed: { filename: string; error: string }[];
  state: 'running' | 'finished';
}

let run: ExportRun | null = null;
let controller: AbortController | null = null;
const listeners = new Set<() => void>();

function update(next: ExportRun | null) {
  run = next;
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The export running or just finished (with failures to show), or null. */
export function useExportRun(): ExportRun | null {
  return useSyncExternalStore(subscribe, () => run);
}

export const exportRunning = () => run?.state === 'running';

/** Stop the running export: what's exported so far is dropped. */
export function cancelExport() {
  controller?.abort();
}

/** Hide a finished export's report. */
export function dismissExport() {
  if (run?.state === 'finished') update(null);
}

/** What a photo needs before it's exported: its original (null: the previous photo's) and recipe. */
interface Input {
  bytes: ArrayBuffer | null;
  /** Null for a new upload not read by the server yet: it starts from the recipe for its file. */
  recipe: EditParams | null;
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
const settle = <T>(p: Promise<T>): Promise<Settled<T>> =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

/** A photo's original, failing with what went wrong. */
const download = (url: string, signal: AbortSignal) =>
  fetchBytes(url, undefined, signal).catch((err: unknown) => {
    throw new Error(`Could not download the original (${message(err)})`);
  });

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Export `photos` (versions, in this order) with `settings`. Returns false without
 * starting when an export is already running.
 */
export function startExport(photos: readonly Photo[], settings: ExportSettings): boolean {
  if (exportRunning() || !photos.length) return false;
  const abort = new AbortController();
  controller = abort;
  update({ total: photos.length, done: 0, exported: 0, current: photos[0]!.filename, failed: [], state: 'running' });
  void exportAll(photos, settings, abort.signal).finally(() => {
    if (controller === abort) controller = null;
  });
  return true;
}

async function exportAll(photos: readonly Photo[], settings: ExportSettings, signal: AbortSignal) {
  const newBackend = () => {
    const b = new LocalRenderBackend();
    b.setLutSource(lutTable);
    return b;
  };
  let backend = newBackend();
  // Cancelling stops the worker at once, whatever it's doing.
  const stop = () => backend.dispose();
  signal.addEventListener('abort', stop);

  const format = EXPORT_FORMATS.find((f) => f.value === settings.format)!;
  const options = exportOptions(settings);
  const single = photos.length === 1;
  const zip = new ZipWriter();
  let file: { blob: Blob; name: string } | null = null;
  const failed: ExportRun['failed'] = [];
  let exported = 0;

  // Versions of one file share its original: it's fetched and decoded once for them.
  const prepare = (i: number): Promise<Settled<Input>> => {
    const photo = photos[i]!;
    const same = i > 0 && photos[i - 1]!.originalUrl === photo.originalUrl;
    return settle(
      Promise.all([same ? null : download(photo.originalUrl, signal), fetchRecipe(photo.id)]).then(
        ([bytes, recipe]) => ({ bytes, recipe }),
      ),
    );
  };

  let loaded = null as { url: string; metadata: PhotoMetadata } | null;
  // The next photo's original downloads while one exports.
  let next = prepare(0);
  for (let i = 0; i < photos.length && !signal.aborted; i++) {
    const photo = photos[i]!;
    update({ ...run!, current: photo.filename });
    const input = await next;
    if (i + 1 < photos.length) next = prepare(i + 1);
    try {
      if (!input.ok) throw input.error;
      const { recipe } = input.value;
      let metadata = loaded?.url === photo.originalUrl ? loaded.metadata : null;
      if (!metadata) {
        // Fetched again if the version before, with the same original, failed.
        const bytes: ArrayBuffer = input.value.bytes ?? (await download(photo.originalUrl, signal));
        loaded = null;
        metadata = await backend.load(bytes);
        loaded = { url: photo.originalUrl, metadata };
      }
      // Pending auto-tunes are measured as the server's previews measure them.
      const params = await resolveAutoTunes(recipe ?? defaultRecipe(metadata), backendMeasures(backend));
      const info = photoExportInfo(photo, metadata);
      const blob = await backend.export(params, options, info.metadata);
      const name = uniqueName(exportFilename(settings.filename, info.filename, format.extension), (n) => zip.has(n));
      if (single) file = { blob, name };
      else await zip.add(name, blob);
      exported++;
    } catch (err) {
      if (signal.aborted) break;
      failed.push({ filename: photo.filename, error: message(err) });
      // A fresh worker for the next one, in case this one is left in a bad state (memory).
      backend.dispose();
      backend = newBackend();
      loaded = null;
    }
    update({ ...run!, done: i + 1, exported, failed: [...failed] });
  }
  signal.removeEventListener('abort', stop);
  backend.dispose();

  if (signal.aborted) {
    update(null);
    toaster.create({ type: 'info', title: 'Export cancelled', duration: 3000 });
    return;
  }
  if (file) saveBlob(file.blob, file.name);
  else if (zip.count) saveBlob(zip.finish(), archiveName(new Date()));
  update({ ...run!, current: null, state: 'finished' });
  // Without failures there's nothing to report beyond a toast.
  if (!failed.length) {
    update(null);
    toaster.create({
      type: 'success',
      title: single ? `Exported ${file?.name ?? photos[0]!.filename}` : `Exported ${exported} photos`,
      duration: 4000,
    });
  }
}
