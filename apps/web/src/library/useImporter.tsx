import { useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { type NavigateFunction, useNavigate } from 'react-router';
import { api } from '../api/client.ts';
import type { StorageUsage } from '../api/types.ts';
import { toaster } from '../components/toaster.tsx';
import { ImportSummary } from './ImportToast.tsx';
import { type ImportDeps, retryFailed, startImport, uploadDeleted, useImportRun } from './imports.ts';

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
  return (files: File[]) => {
    if (!files.length) return;
    navigate(importPath(startImport(files, deps)));
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
