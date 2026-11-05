import {
  type InfiniteData,
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { ModuleKind, ModulePresetPayload, Preset, StylePayload } from '@rawtisserie/pipeline';
import { useCallback } from 'react';
import type { HistoryOp } from '../develop/history.ts';
import { type BatchEdit, runBatchEdit, undoBatchEdit } from '../library/batchEdit.ts';
import { toaster } from '../components/toaster.tsx';
import { ApiError, api } from './client.ts';
import type { BulkPatch, Facets, Photo, PhotoDetail, PhotoPatch, User } from './types.ts';

// ── Auth ────────────────────────────────────────────────────────────────────

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return (await api.get<{ user: User }>('/api/auth/me')).user;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: Infinity,
  });
}

export function useAuthConfig() {
  return useQuery({
    queryKey: ['auth-config'],
    queryFn: () => api.get<{ allowSignup: boolean }>('/api/auth/config'),
    staleTime: Infinity,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; password: string }) => api.post<{ user: User }>('/api/auth/login', body),
    onSuccess: ({ user }) => qc.setQueryData(['me'], user),
  });
}

export function useSignup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; password: string; displayName: string }) =>
      api.post<{ user: User }>('/api/auth/signup', body),
    onSuccess: ({ user }) => qc.setQueryData(['me'], user),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/api/auth/logout'),
    onSuccess: () => {
      qc.clear();
      qc.setQueryData(['me'], null);
    },
  });
}

// ── Library ─────────────────────────────────────────────────────────────────

const PAGE_SIZE = 200;

interface PhotoPage {
  versions: Photo[];
  total: number;
}

/** `search` is the library's URL query string (same parameter names as the API). */
export function usePhotos(search: string) {
  return useInfiniteQuery({
    queryKey: ['photos', search],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams(search);
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(pageParam));
      return api.get<PhotoPage>(`/api/versions?${params}`);
    },
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.versions.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
    // Keep polling while previews are being rendered.
    refetchInterval: (query) =>
      query.state.data?.pages.some((p) => p.versions.some((v) => v.renderStatus === 'pending')) ? 2000 : false,
  });
}

export function useFacets(search: string) {
  const params = new URLSearchParams(search);
  params.delete('sort');
  return useQuery({
    queryKey: ['facets', params.toString()],
    queryFn: () => api.get<Facets>(`/api/versions/facets?${params}`),
    placeholderData: (prev) => prev,
  });
}

export function usePhoto(id: string | undefined) {
  return useQuery({
    queryKey: ['photo', id],
    queryFn: () => api.get<PhotoDetail>(`/api/versions/${id}`),
    enabled: !!id,
  });
}

/** Apply a change to every cached copy of the given photos (optimistic UI for culling). */
function updateCachedPhotos(qc: QueryClient, ids: string[], update: (p: Photo) => Photo) {
  const set = new Set(ids);
  qc.setQueriesData<InfiniteData<PhotoPage>>({ queryKey: ['photos'] }, (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            versions: page.versions.map((p) => (set.has(p.id) ? update(p) : p)),
          })),
        }
      : data,
  );
  for (const id of ids) {
    qc.setQueryData<PhotoDetail>(['photo', id], (p) => (p ? { ...p, ...update(p) } : p));
  }
}

function refreshLibrary(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: ['photos'] });
  void qc.invalidateQueries({ queryKey: ['facets'] });
}

/** After versions were added, removed or reordered: their siblings' details are stale too. */
function refreshVersions(qc: QueryClient) {
  refreshLibrary(qc);
  void qc.invalidateQueries({ queryKey: ['photo'] });
}

export function useUpdatePhoto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: PhotoPatch }) =>
      api.patch<PhotoDetail>(`/api/versions/${id}`, patch),
    onMutate: ({ id, patch }) => updateCachedPhotos(qc, [id], (p) => ({ ...p, ...patch })),
    onSuccess: (photo) => {
      qc.setQueryData(['photo', photo.id], photo);
      updateCachedPhotos(qc, [photo.id], (p) => ({ ...p, ...photo }));
    },
    // Metadata belongs to the photo, and names show in the version switcher: other
    // versions of it change too.
    onSettled: () => refreshVersions(qc),
  });
}

export function useBulkUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, patch }: { ids: string[]; patch: BulkPatch }) =>
      api.post<{ versions: Photo[] }>('/api/versions/bulk', { ids, patch }),
    onMutate: ({ ids, patch }) => {
      const { addTags, removeTags, ...simple } = patch;
      updateCachedPhotos(qc, ids, (p) => ({
        ...p,
        ...simple,
        tags: p.tags.filter((t) => !removeTags?.includes(t)).concat((addTags ?? []).filter((t) => !p.tags.includes(t))),
      }));
    },
    onSettled: () => refreshLibrary(qc),
  });
}

export function useDeletePhotos() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => api.post<{ deleted: string[] }>('/api/versions/delete', { ids }),
    onSuccess: ({ deleted }) => {
      const gone = new Set(deleted);
      qc.setQueriesData<InfiniteData<PhotoPage>>({ queryKey: ['photos'] }, (data) =>
        data
          ? {
              ...data,
              pages: data.pages.map((page) => ({
                total: page.total - deleted.length,
                versions: page.versions.filter((p) => !gone.has(p.id)),
              })),
            }
          : data,
      );
    },
    onSettled: () => refreshVersions(qc),
  });
}

/** Duplicate a version (with its history, or from the original). Resolves to the new version. */
export function useDuplicateVersion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, fromOriginal = false }: { id: string; fromOriginal?: boolean }) =>
      api.post<PhotoDetail>(`/api/versions/${id}/duplicate`, { fromOriginal }),
    onSuccess: (photo) => qc.setQueryData(['photo', photo.id], photo),
    onSettled: () => refreshVersions(qc),
  });
}

/** Move a version to `position` (0-based) among its photo's versions. */
export function useMoveVersion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, position }: { id: string; position: number }) =>
      api.post<PhotoDetail>(`/api/versions/${id}/move`, { position }),
    onSettled: () => refreshVersions(qc),
  });
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Apply a preset or style to versions (`runBatchEdit`), with progress, a summary and an
 * Undo in a toast. Previews are re-rendered by the server.
 */
export function useBatchEdit() {
  const qc = useQueryClient();
  return useCallback(
    async (ids: string[], edit: BatchEdit) => {
      if (!ids.length) return;
      const toast = toaster.create({ type: 'loading', title: `${edit.label}…`, description: `0 of ${ids.length}` });
      try {
        const { edited, unchanged, notReady, failed } = await runBatchEdit(ids, edit, (done) =>
          toaster.update(toast, { type: 'loading', title: `${edit.label}…`, description: `${done} of ${ids.length}` }),
        );
        const notes = [
          unchanged && `${plural(unchanged, 'photo')} already had it`,
          notReady && `${plural(notReady, 'photo')} still being imported: try again in a moment`,
          failed && `${plural(failed, 'photo')} changed elsewhere or were deleted: not edited`,
        ].filter(Boolean);
        toaster.update(toast, {
          type: failed || notReady ? 'warning' : 'success',
          title: `${edit.label}: ${plural(edited.length, 'photo')} edited`,
          description: notes.join('\n') || undefined,
          closable: true,
          duration: failed || notReady ? 10000 : 6000,
          ...(edited.length && {
            action: {
              label: 'Undo',
              onClick: () =>
                void undoBatchEdit(edited)
                  .then((undone) =>
                    toaster.create({
                      type: undone < edited.length ? 'warning' : 'info',
                      title: `Undid ${edit.label} on ${plural(undone, 'photo')}`,
                      description:
                        undone < edited.length
                          ? `${edited.length - undone} were edited since: undo them in the developer`
                          : undefined,
                    }),
                  )
                  .catch((err) => toaster.create({ type: 'error', title: 'Could not undo', description: String(err) }))
                  .finally(() => refreshVersions(qc)),
            },
          }),
        });
      } catch (err) {
        toaster.update(toast, {
          type: 'error',
          title: `Could not apply ${edit.label}`,
          description: err instanceof Error ? err.message : undefined,
          closable: true,
        });
      } finally {
        refreshVersions(qc);
      }
    },
    [qc],
  );
}

export interface UploadResult {
  created: Photo[];
  skipped: { filename: string; reason: string }[];
}

/** Upload files one at a time so progress can be reported. */
export function useUpload() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ files, onProgress }: { files: File[]; onProgress?: (done: number) => void }) => {
      const result: UploadResult = { created: [], skipped: [] };
      for (const [i, file] of files.entries()) {
        const form = new FormData();
        form.append('files', file);
        try {
          const r = await api.post<UploadResult>('/api/photos', form);
          result.created.push(...r.created);
          result.skipped.push(...r.skipped);
        } catch (err) {
          result.skipped.push({ filename: file.name, reason: err instanceof Error ? err.message : 'Upload failed' });
        }
        onProgress?.(i + 1);
      }
      return result;
    },
    onSettled: () => refreshLibrary(qc),
  });
}

export interface HistoryWrite {
  ops: HistoryOp[];
  baseRevision: number;
}

/**
 * Apply changes to a version's history. Returns a function (not a mutation) so the
 * caller controls ordering and can save with `keepalive` while the page unloads.
 */
export function useSaveHistory(id: string) {
  const qc = useQueryClient();
  return useCallback(
    async (write: HistoryWrite, options?: { keepalive?: boolean }) => {
      const photo = await api.post<PhotoDetail>(`/api/versions/${id}/history`, write, options);
      qc.setQueryData(['photo', photo.id], photo);
      refreshLibrary(qc);
      return photo.revision;
    },
    [id, qc],
  );
}

// ── Presets ─────────────────────────────────────────────────────────────────

export type PresetInput =
  | { type: 'module'; moduleKind: ModuleKind; name: string; payload: ModulePresetPayload }
  | { type: 'style'; name: string; payload: StylePayload };

const byName = (a: Preset, b: Preset) => a.name.localeCompare(b.name);

/** The user's own presets and styles (none without an account). */
export function useUserPresets() {
  const { data: me } = useMe();
  return useQuery({
    queryKey: ['presets'],
    queryFn: async () => (await api.get<{ presets: Preset[] }>('/api/presets')).presets,
    enabled: !!me,
    staleTime: Infinity,
  });
}

/** Save a preset or style. One with the same name (and kind) is replaced. */
export function useSavePreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PresetInput) => api.post<Preset>('/api/presets', input),
    onSuccess: (preset) =>
      qc.setQueryData<Preset[]>(['presets'], (list = []) =>
        [...list.filter((p) => p.id !== preset.id), preset].sort(byName),
      ),
  });
}

export function useDeletePreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/presets/${id}`),
    onSuccess: (_, id) => qc.setQueryData<Preset[]>(['presets'], (list = []) => list.filter((p) => p.id !== id)),
  });
}
