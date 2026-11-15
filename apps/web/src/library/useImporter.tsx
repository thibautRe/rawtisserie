import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { type NavigateFunction, useNavigate } from 'react-router';
import { api } from '../api/client.ts';
import type { StorageUsage } from '../api/types.ts';
import { toaster } from '../components/toaster.tsx';
import { ImportSummary } from './ImportToast.tsx';
import { type ImportDeps, findKnown, retryFailed, startImport, uploadDeleted, useImportRun } from './imports.ts';
import { ImportReview, type Review } from './ImportReview.tsx';
import { type PickedFile, sortPicked } from './pickedFiles.ts';

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
  // The latest pick wins: an earlier one still being looked through is dropped.
  const latest = useRef(0);

  /** Review files picked or dropped (a drop's folders are walked through first). */
  const start = async (source: PickedFile[] | Promise<PickedFile[]>, label: string | null = null) => {
    const token = ++latest.current;
    setReview({ phase: 'scanning', label });
    const picked = sortPicked(await Promise.resolve(source).catch(() => []));
    if (token !== latest.current) return;
    if (!picked.files.length && !picked.refused.length) {
      setReview(null);
      toaster.create({ type: 'info', title: 'No RAW files there', description: 'Nothing to import.' });
      return;
    }
    const known = await findKnown(picked.files);
    if (token === latest.current) setReview({ phase: 'ready', picked, known });
  };
  const close = () => {
    latest.current++;
    setReview(null);
  };
  const confirm = () => {
    if (review?.phase !== 'ready') return;
    close();
    navigate(importPath(startImport(review.picked, deps, review.known)));
  };
  return { start, review: <ImportReview review={review} onImport={confirm} onClose={close} /> };
}

const toastId = (runId: string) => `import-${runId}`;

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
