import { useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { type NavigateFunction, useNavigate } from 'react-router';
import { api } from '../api/client.ts';
import type { StorageUsage } from '../api/types.ts';
import { toaster } from '../components/toaster.tsx';
import { ImportSummary } from './ImportToast.tsx';
import { type ImportDeps, retryFailed, startImport, uploadDeleted, useImportRun } from './imports.ts';
import { type PickedFile, sortPicked } from './pickedFiles.ts';

/** The library showing one import's photos. */
export const importPath = (id: string) => `/?import=${id}`;

/**
 * Starts imports from the library: a new one gets its toast, and the library shows it
 * (`?import=<id>`, which the user can clear); files added while one runs join it.
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
  /** Import files picked or dropped (a drop's folders are walked through first). */
  return async (source: PickedFile[] | Promise<PickedFile[]>) => {
    const picked = sortPicked(await source);
    if (!picked.files.length && !picked.refused.length) return;
    navigate(importPath(startImport(picked, deps)));
  };
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
