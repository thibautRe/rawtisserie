import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type NavigateFunction, useNavigate } from 'react-router';
import { api } from '../api/client.ts';
import type { StorageUsage } from '@rawtisserie/api';
import { toaster } from '../components/toaster.tsx';
import { ImportSummary, InterruptedImport } from './ImportToast.tsx';
import { forgetImport, interruptedImports, isPending, matchFiles, startSaving } from './importQueue.ts';
import {
  type ImportDeps,
  type ImportRun,
  findKnown,
  resumeImport,
  retryFailed,
  startImport,
  uploadDeleted,
  useImportRun,
} from './imports.ts';
import { type FileTags, isEmpty, photosToRead, readFileTags } from './fileTags.ts';
import { readCaptureTimes } from './captureTime.ts';
import {
  type Sorting,
  defaultSorting,
  planCollections,
  rememberSorting,
  rememberedSorting,
} from './importCollections.ts';
import { ImportReview, type Review, type ScanProgress, reviewedFiles } from './ImportReview.tsx';
import {
  type Listing,
  type PickedFile,
  type PickedFrom,
  fromInput,
  reopen,
  sortPicked,
  walkHandles,
  withPairs,
} from './pickedFiles.ts';

/** The library showing one import's photos. */
export const importPath = (id: string) => `/?import=${id}`;

/**
 * Starts imports from the library. What was picked is reviewed first (`ImportReview`:
 * what's new, what the library has already); then a new import gets its toast, and the
 * library shows it (`?import=<id>`, which the user can clear); files added while one
 * runs join it. Place `review` in the page.
 */
export function useImporter() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const deps = useMemo<ImportDeps>(
    () => ({
      storage: () =>
        qc.fetchQuery({
          queryKey: ['storage'],
          queryFn: () => api.get<StorageUsage>('/api/account/storage'),
          staleTime: 0,
        }),
      refresh: () => {
        void qc.invalidateQueries({ queryKey: ['photos'] });
        void qc.invalidateQueries({ queryKey: ['facets'] });
        void qc.invalidateQueries({ queryKey: ['storage'] });
      },
      // The toaster is outside the router: it navigates with this page's `navigate`.
      onStart: (run) =>
        toaster.create({
          id: toastId(run.id),
          type: 'info',
          duration: Infinity,
          closable: false,
          meta: { render: () => <LiveImport runId={run.id} deps={deps} navigate={navigate} /> },
        }),
    }),
    [qc, navigate],
  );
  const [review, setReview] = useState<Review | null>(null);
  // The latest pick wins: an earlier one still being looked through is dropped (and
  // stops reading its files).
  const latest = useRef(0);
  const reading = useRef<AbortController | null>(null);
  const from = useRef<PickedFrom | undefined>(undefined);

  // Imports interrupted before (a reload, the browser closed): offered to resume, once.
  useEffect(() => {
    startSaving();
    void interruptedImports().then((list) => {
      for (const run of list)
        toaster.create({
          id: interruptedId(run.id),
          type: 'info',
          duration: Infinity,
          closable: false,
          meta: { render: () => <Interrupted run={run} deps={deps} navigate={navigate} /> },
        });
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Review files picked or dropped (a drop's folders are walked through first, counted
   * in `listing`). `origin` says where they came from, to open them again after a reload.
   * How it goes is shown a few times a second: a large folder takes minutes.
   */
  const start = async (source: PickedFile[] | Promise<PickedFile[]>, origin?: PickedFrom, listing?: Listing) => {
    const token = ++latest.current;
    reading.current?.abort();
    const abort = (reading.current = new AbortController());
    from.current = origin;
    const read = { done: 0 };
    let step: ScanProgress['step'] = 'listing';
    let total = 0;
    const show = () => {
      if (token !== latest.current) return;
      const progress: ScanProgress =
        step === 'listing'
          ? { step, found: listing?.found ?? 0 }
          : step === 'checking'
            ? { step, photos: total }
            : { step, done: read.done, total };
      setReview({ phase: 'scanning', label: null, progress });
    };
    show();
    const timer = setInterval(show, 250);
    try {
      const picked = sortPicked(await Promise.resolve(source).catch(() => []));
      if (token !== latest.current) return;
      if (!picked.files.length && !picked.pairs.length && !picked.refused.length) {
        setReview(null);
        toaster.create({ type: 'info', title: 'No photos there', description: 'Nothing to import.' });
        return;
      }
      // The pairs too: they may be asked for.
      step = 'checking';
      total = picked.files.length + picked.pairs.length;
      show();
      const known = await findKnown(withPairs(picked, true).files);
      if (token !== latest.current) return;
      // Then the files' tags and capture times (for collections by day), for the new
      // photos only: what the library has is skipped.
      step = 'reading';
      const fresh = photosToRead(picked, known);
      total = fresh.length * 2;
      show();
      const [fileTags, times] = await Promise.all([
        readFileTags(picked, { skip: known, progress: read, signal: abort.signal }),
        readCaptureTimes(fresh, { progress: read, signal: abort.signal }),
      ]);
      const all = [...picked.files, ...picked.pairs];
      const sorting = rememberedSorting(defaultSorting(all), all);
      if (token === latest.current)
        setReview({ phase: 'ready', picked, known, includePairs: false, importEdits: true, fileTags, times, sorting });
    } finally {
      clearInterval(timer);
    }
  };
  const close = () => {
    latest.current++;
    reading.current?.abort();
    setReview(null);
  };
  const confirm = () => {
    if (review?.phase !== 'ready') return;
    close();
    const files = reviewedFiles(review);
    rememberSorting(review.sorting, [...review.picked.files, ...review.picked.pairs]);
    const plan = planCollections(files.files, review.times, review.sorting);
    const fileTags = review.importEdits ? review.fileTags : withoutEdits(review.fileTags);
    navigate(importPath(startImport(files, deps, review.known, from.current, fileTags, plan.of)));
  };
  const importEdits = (include: boolean) =>
    setReview((r) => (r?.phase === 'ready' ? { ...r, importEdits: include } : r));
  const includePairs = (include: boolean) =>
    setReview((r) => (r?.phase === 'ready' ? { ...r, includePairs: include } : r));
  const sort = (sorting: Sorting) => setReview((r) => (r?.phase === 'ready' ? { ...r, sorting } : r));
  return {
    start,
    review: (
      <ImportReview
        review={review}
        onImport={confirm}
        onIncludePairs={includePairs}
        onImportEdits={importEdits}
        onSorting={sort}
        onClose={close}
      />
    ),
  };
}

/** `fileTags` without edits from other applications, nor their duplicates (the review was told not to import them). */
function withoutEdits(fileTags: ReadonlyMap<PickedFile, FileTags>): ReadonlyMap<PickedFile, FileTags> {
  const out = new Map<PickedFile, FileTags>();
  for (const [f, { edits: _, duplicates: __, ...rest }] of fileTags) if (!isEmpty(rest)) out.set(f, rest);
  return out;
}

const toastId = (runId: string) => `import-${runId}`;
const interruptedId = (runId: string) => `interrupted-${runId}`;

/** Files picked again with a picker of the browser's own (no handles kept): [] if cancelled. */
function pickAgain(kind: PickedFrom['kind']): Promise<PickedFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    if (kind === 'folder') input.setAttribute('webkitdirectory', '');
    input.hidden = true;
    const done = (files: PickedFile[]) => {
      input.remove();
      resolve(files);
    };
    input.onchange = () => done(fromInput(input.files ?? []));
    input.oncancel = () => done([]);
    document.body.append(input);
    input.click();
  });
}

function Interrupted({ run, deps, navigate }: { run: ImportRun; deps: ImportDeps; navigate: NavigateFunction }) {
  const [busy, setBusy] = useState(false);
  const pending = run.items.filter(isPending).length;
  const resume = async () => {
    setBusy(true);
    try {
      const handles = run.from.handles;
      // Kept by the browser: opened again, with the user's permission (asked now, in the click).
      const files =
        handles && (await reopen(handles).catch(() => false))
          ? await walkHandles(handles).catch(() => [])
          : await pickAgain(run.from.kind);
      if (!files.length) return;
      const found = matchFiles(run, files);
      if (!found.size) {
        toaster.create({
          type: 'error',
          title: 'None of its files are there',
          description: run.label ? `Pick ${run.label}, as for the import.` : 'Pick the same files as for the import.',
        });
        return;
      }
      toaster.dismiss(interruptedId(run.id));
      resumeImport(run, found, deps);
      navigate(importPath(run.id));
    } finally {
      setBusy(false);
    }
  };
  return (
    <InterruptedImport
      run={run}
      pending={pending}
      busy={busy}
      onResume={() => void resume()}
      onDiscard={() => {
        void forgetImport(run);
        toaster.dismiss(interruptedId(run.id));
      }}
    />
  );
}

function LiveImport({ runId, deps, navigate }: { runId: string; deps: ImportDeps; navigate: NavigateFunction }) {
  const run = useImportRun(runId);
  if (!run) return null;
  return (
    <ImportSummary
      run={run}
      onShow={() => navigate(importPath(runId))}
      onRetry={() => retryFailed(runId, deps)}
      onUploadDeleted={() => uploadDeleted(runId, deps)}
      onClose={() => toaster.dismiss(toastId(runId))}
    />
  );
}
