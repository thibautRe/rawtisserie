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
import { photoExportInfo, photoFilenameFields } from '../develop/exportInfo.ts';
import { LocalRenderBackend } from '../develop/localRenderBackend.ts';
import { lutTable } from '../develop/luts.ts';
import { saveBlob } from '../lib/download.ts';
import { ZipWriter } from '../lib/zip.ts';
import { fetchRecipe } from '../library/batchEdit.ts';
import { exportLanes, originalGroups } from './lanes.ts';
import { archiveName, uniqueName } from './names.ts';

export interface ExportRun {
  total: number;
  /** Photos finished, exported or not. */
  done: number;
  exported: number;
  /** The file names of the photos being exported. */
  current: string[];
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

/** What a group of photos needs before it's exported: their original, and each one's recipe. */
interface Input {
  /** Null once it's been handed to a worker (transferred). */
  bytes: ArrayBuffer | null;
  /** Null for a new upload not read by the server yet: it starts from the recipe for its file. */
  recipes: (EditParams | null)[];
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
  update({ total: photos.length, done: 0, exported: 0, current: [], failed: [], state: 'running' });
  void exportAll(photos, settings, abort.signal).finally(() => {
    if (controller === abort) controller = null;
  });
  return true;
}

async function exportAll(photos: readonly Photo[], settings: ExportSettings, signal: AbortSignal) {
  const format = EXPORT_FORMATS.find((f) => f.value === settings.format)!;
  const options = exportOptions(settings);
  const single = photos.length === 1;
  // Names are given in the photos' order, whatever order they finish in.
  const taken = new Set<string>();
  const names = photos.map((p) => {
    const name = uniqueName(exportFilename(settings.filename, photoFilenameFields(p), format.extension), (n) =>
      taken.has(n),
    );
    taken.add(name);
    return name;
  });
  const zip = new ZipWriter();
  let file = null as { blob: Blob; name: string } | null;
  const failed: ExportRun['failed'] = [];
  const current = new Set<number>();
  let done = 0;
  let exported = 0;
  const report = () =>
    update({
      ...run!,
      done,
      exported,
      current: [...current].sort((a, b) => a - b).map((i) => photos[i]!.filename),
      failed: [...failed],
    });

  // Cancelling stops every worker at once, whatever it's doing.
  const backends = new Set<LocalRenderBackend>();
  const newBackend = () => {
    const b = new LocalRenderBackend({ pool: false });
    b.setLutSource(lutTable);
    backends.add(b);
    return b;
  };
  const dispose = (b: LocalRenderBackend) => {
    b.dispose();
    backends.delete(b);
  };
  const stop = () => [...backends].forEach(dispose);
  signal.addEventListener('abort', stop);

  // Versions of one file share its original: it's fetched and decoded once for them, on one lane.
  const groups = originalGroups(photos.map((p) => p.originalUrl));
  let claimed = 0;
  const claim = () => (claimed < groups.length ? groups[claimed++]! : null);
  const prepare = (group: number[]): Promise<Settled<Input>> =>
    settle(
      Promise.all([
        download(photos[group[0]!]!.originalUrl, signal),
        Promise.all(group.map((i) => fetchRecipe(photos[i]!.id))),
      ]).then(([bytes, recipes]) => ({ bytes, recipes })),
    );

  const lane = async () => {
    let backend = newBackend();
    let group = claim();
    let input = group && prepare(group);
    while (group && input && !signal.aborted) {
      // The lane's next original downloads while this one exports.
      const following = claim();
      const next = following && prepare(following);
      const got = await input;
      let metadata: PhotoMetadata | null = null;
      for (const [k, i] of group.entries()) {
        if (signal.aborted) break;
        const photo = photos[i]!;
        current.add(i);
        report();
        try {
          if (!got.ok) throw got.error;
          if (!metadata) {
            // Fetched again if a version before it failed (its worker was replaced).
            const bytes = got.value.bytes ?? (await download(photo.originalUrl, signal));
            got.value.bytes = null;
            metadata = await backend.load(bytes);
          }
          // Pending auto-tunes are measured as the server's previews measure them.
          const recipe = got.value.recipes[k] ?? defaultRecipe(metadata);
          const params = await resolveAutoTunes(recipe, backendMeasures(backend));
          const blob = await backend.export(params, options, photoExportInfo(photo, metadata).metadata);
          if (single) file = { blob, name: names[i]! };
          else await zip.add(names[i]!, blob);
          exported++;
        } catch (err) {
          if (signal.aborted) break;
          failed.push({ filename: photo.filename, error: message(err) });
          // A fresh worker for the next one, in case this one is left in a bad state (memory).
          dispose(backend);
          backend = newBackend();
          metadata = null;
        } finally {
          current.delete(i);
        }
        done++;
        report();
      }
      group = following;
      input = next;
    }
    dispose(backend);
  };
  await Promise.all(Array.from({ length: Math.min(exportLanes(), groups.length) }, lane));
  signal.removeEventListener('abort', stop);

  if (signal.aborted) {
    update(null);
    toaster.create({ type: 'info', title: 'Export cancelled', duration: 3000 });
    return;
  }
  if (file) saveBlob(file.blob, file.name);
  else if (zip.count) saveBlob(zip.finish(), archiveName(new Date()));
  update({ ...run!, current: [], state: 'finished' });
  // Without failures there's nothing to report beyond a toast.
  if (!failed.length) {
    update(null);
    toaster.create({
      type: 'success',
      title: single ? `Exported ${names[0]}` : `Exported ${exported} photos`,
      duration: 4000,
    });
  }
}
