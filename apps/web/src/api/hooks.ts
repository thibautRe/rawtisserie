import {
  type InfiniteData,
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type {
  ExportPreset,
  ExportSettings,
  ModuleKind,
  ModulePresetPayload,
  Preset,
  StylePayload,
} from '@rawtisserie/pipeline';
import { useCallback, useMemo, useState } from 'react';
import type { HistoryOp } from '../develop/history.ts';
import { type BatchEdit, runBatchEdit, undoBatchEdit } from '../library/batchEdit.ts';
import type { ZoomInfo } from '../library/loupe.ts';
import { toaster } from '../components/toaster.tsx';
import { ApiError, api } from './client.ts';
import { clearOriginals } from './originals.ts';
import type {
  AdminStats,
  AdminUser,
  BulkPatch,
  FacetValue,
  Facets,
  Invitation,
  Photo,
  PhotoDetail,
  PhotoPatch,
  StorageUsage,
  TrashPage,
  User,
} from './types.ts';

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

/** Whether an invitation code can be used, and the storage it gives. */
export function useInvitationCheck(code: string | null) {
  return useQuery({
    queryKey: ['invitation', code],
    queryFn: () => api.get<{ storageQuota: number | null }>(`/api/auth/invitations/${encodeURIComponent(code!)}`),
    enabled: !!code,
    retry: false,
  });
}

export function useSignup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; password: string; displayName: string; invitation?: string }) =>
      api.post<{ user: User }>('/api/auth/signup', body),
    onSuccess: ({ user }) => qc.setQueryData(['me'], user),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/api/auth/logout'),
    onSuccess: () => {
      clearOriginals();
      qc.clear();
      qc.setQueryData(['me'], null);
    },
  });
}

// ── Library ─────────────────────────────────────────────────────────────────

export const PAGE_SIZE = 200;

interface PhotoPage {
  versions: Photo[];
  total: number;
}

/** Cached library lists: `usePhotos`' pages in a row, or one of `useLibraryPhotos`' pages. */
type CachedPhotos = InfiniteData<PhotoPage> | PhotoPage;
const mapPages = (data: CachedPhotos | undefined, f: (page: PhotoPage) => PhotoPage) =>
  !data ? data : 'pages' in data ? { ...data, pages: data.pages.map(f) } : f(data);

const fetchPage = (search: string, offset: number) => {
  const params = new URLSearchParams(search);
  params.set('limit', String(PAGE_SIZE));
  params.set('offset', String(offset));
  return api.get<PhotoPage>(`/api/versions?${params}`);
};

/**
 * The library's photos at any position, for a grid that reserves room for all of them:
 * `items` has one slot per photo, undefined until its page is in. `want` asks for the
 * pages holding a range of positions (those on screen); the first one always is.
 */
export function useLibraryPhotos(search: string) {
  return usePagedVersions(['photos', search], (offset) => fetchPage(search, offset));
}

/** The trash, like the library (`useLibraryPhotos`), with the latest page's summary. */
export function useTrashPhotos() {
  const paged = usePagedVersions(['trash'], (offset) =>
    api.get<TrashPage>(`/api/trash?limit=${PAGE_SIZE}&offset=${offset}`),
  );
  return { ...paged, summary: paged.latest };
}

/** Versions listed by pages of `PAGE_SIZE` (`load` gets one from its offset), each cached under `key`. */
function usePagedVersions<P extends { versions: Photo[]; total: number }>(
  key: readonly unknown[],
  load: (offset: number) => Promise<P>,
) {
  const keyString = JSON.stringify(key);
  const [wanted, setWanted] = useState({ key: keyString, pages: new Set([0]) });
  const pages = wanted.key === keyString ? [...wanted.pages].sort((a, b) => a - b) : [0];
  const results = useQueries({
    queries: pages.map((page) => ({
      queryKey: [...key, 'page', page],
      queryFn: () => load(page * PAGE_SIZE),
      // Kept while developing, so going back to the library finds the pages it showed.
      gcTime: 60 * 60_000,
      // Keep polling while previews are being rendered.
      refetchInterval: (query: { state: { data?: P } }) =>
        query.state.data?.versions.some((v) => v.renderStatus === 'pending') ? 2000 : false,
    })),
  });
  const datas = results.map((r) => r.data);
  const updated = results.map((r) => r.dataUpdatedAt);
  const { items, total, latest } = useMemo(() => {
    // The latest page knows the latest total.
    let latest = -1;
    datas.forEach((d, i) => d && (latest < 0 || updated[i]! > updated[latest]!) && (latest = i));
    const total = latest < 0 ? 0 : datas[latest]!.total;
    const items: (P['versions'][number] | undefined)[] = new Array(total).fill(undefined);
    datas.forEach((d, i) =>
      d?.versions.forEach((p, k) => {
        const at = pages[i]! * PAGE_SIZE + k;
        if (at < total) items[at] = p;
      }),
    );
    return { items, total, latest: latest < 0 ? undefined : datas[latest] };
    // Any change of a page's data changes its update time.
  }, [pages.join(), updated.join()]); // eslint-disable-line react-hooks/exhaustive-deps

  const want = useCallback(
    (start: number, end: number) =>
      setWanted((w) => {
        const base = w.key === keyString ? w.pages : new Set([0]);
        const missing: number[] = [];
        for (let p = Math.floor(Math.max(0, start) / PAGE_SIZE); p <= Math.floor(Math.max(0, end) / PAGE_SIZE); p++) {
          if (!base.has(p)) missing.push(p);
        }
        if (!missing.length && w.key === keyString) return w;
        return { key: keyString, pages: new Set([...base, ...missing]) };
      }),
    [keyString],
  );
  return {
    items,
    total,
    latest,
    want,
    /** Before the first page is in. */
    isPending: results[0]?.isPending ?? true,
    isFetching: results.some((r) => r.isFetching),
  };
}

/** `search` is the library's URL query string (same parameter names as the API). */
export function usePhotos(search: string) {
  return useInfiniteQuery({
    queryKey: ['photos', search],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => fetchPage(search, pageParam),
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.versions.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
    // Kept while developing, so going back to the library finds the pages it scrolled through.
    gcTime: 60 * 60_000,
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

/** Every tag in the library with its use count. Under `facets`, so library changes refresh it. */
export function useAllTags() {
  return useQuery({
    queryKey: ['facets', 'all-tags'],
    queryFn: () => api.get<FacetValue[]>('/api/tags'),
    staleTime: 60_000,
  });
}

export function usePhoto(id: string | undefined) {
  return useQuery({
    queryKey: ['photo', id],
    queryFn: () => api.get<PhotoDetail>(`/api/versions/${id}`),
    enabled: !!id,
  });
}

/**
 * The zoom levels of a version's current recipe, for the culling loupe. Keyed by its
 * preview's URL, which changes once an edit has been rendered: the tiles' cache key
 * (the recipe's revision) is then asked again.
 */
export function useZoomInfo(photo: Pick<Photo, 'id' | 'previewUrl'>, enabled: boolean) {
  return useQuery({
    queryKey: ['zoom', photo.id, photo.previewUrl],
    queryFn: () => api.get<ZoomInfo>(`/api/versions/${photo.id}/zoom`),
    enabled,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
  });
}

/** Apply a change to every cached copy of the given photos (optimistic UI for culling). */
function updateCachedPhotos(qc: QueryClient, ids: string[], update: (p: Photo) => Photo) {
  const set = new Set(ids);
  qc.setQueriesData<CachedPhotos>({ queryKey: ['photos'] }, (data) =>
    mapPages(data, (page) => ({ ...page, versions: page.versions.map((p) => (set.has(p.id) ? update(p) : p)) })),
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

/**
 * Move versions to the trash (restorable for 30 days). Their files stay stored, so the
 * storage used doesn't change.
 */
export function useMoveToTrash() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => api.post<{ trashed: string[] }>('/api/versions/delete', { ids }),
    onSuccess: ({ trashed }) => {
      const gone = new Set(trashed);
      qc.setQueriesData<CachedPhotos>({ queryKey: ['photos'] }, (data) =>
        mapPages(data, (page) => ({
          total: page.total - page.versions.filter((p) => gone.has(p.id)).length,
          versions: page.versions.filter((p) => !gone.has(p.id)),
        })),
      );
    },
    onSettled: () => {
      refreshVersions(qc);
      void qc.invalidateQueries({ queryKey: ['trash'] });
      void qc.invalidateQueries({ queryKey: ['storage'] });
    },
  });
}

/** Put versions from the trash back in the library. */
export function useRestoreFromTrash() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => api.post<{ restored: string[] }>('/api/trash/restore', { ids }),
    onSettled: () => {
      refreshVersions(qc);
      void qc.invalidateQueries({ queryKey: ['trash'] });
      void qc.invalidateQueries({ queryKey: ['storage'] });
    },
  });
}

/** How many versions are in the trash (a page of one). */
export function useTrashSummary() {
  return useQuery({ queryKey: ['trash', 'summary'], queryFn: () => api.get<TrashPage>('/api/trash?limit=1') });
}

/** Change the user's password: their other sessions are signed out. */
export function useChangePassword() {
  return useMutation({
    mutationFn: (body: { currentPassword: string; newPassword: string }) => api.post('/api/auth/password', body),
  });
}

/** Delete versions from the trash for good (`ids`), or everything in it (`'all'`). */
export function useDeleteForever() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[] | 'all') =>
      ids === 'all'
        ? api.post<{ deleted: string[] }>('/api/trash/empty')
        : api.post<{ deleted: string[] }>('/api/trash/delete', { ids }),
    onSettled: () => {
      // A photo's original goes with its last version.
      void qc.invalidateQueries({ queryKey: ['storage'] });
      void qc.invalidateQueries({ queryKey: ['trash'] });
    },
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

/** What `POST /api/photos` answers (imports: `library/imports.ts`). */
export interface UploadResult {
  created: Photo[];
  skipped: { filename: string; kind: string; reason: string }[];
}

// ── Storage and admin ───────────────────────────────────────────────────────

const fetchStorage = () => api.get<StorageUsage>('/api/account/storage');

/** The user's original files against their quota. */
export function useStorage(enabled = true) {
  return useQuery({ queryKey: ['storage'], queryFn: fetchStorage, enabled });
}

export function useAdminStats() {
  return useQuery({ queryKey: ['admin', 'stats'], queryFn: () => api.get<AdminStats>('/api/admin/stats') });
}

export function useAdminUsers() {
  return useQuery({
    queryKey: ['admin', 'users'],
    queryFn: async () => (await api.get<{ users: AdminUser[] }>('/api/admin/users')).users,
  });
}

export function useUpdateAdminUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string; storageQuota?: number | null; isAdmin?: boolean }) =>
      api.patch<{ user: AdminUser }>(`/api/admin/users/${id}`, patch),
    onSuccess: ({ user }) => {
      qc.setQueryData<AdminUser[]>(['admin', 'users'], (list) => list?.map((u) => (u.id === user.id ? user : u)));
      void qc.invalidateQueries({ queryKey: ['storage'] });
    },
  });
}

export function useInvitations() {
  return useQuery({
    queryKey: ['admin', 'invitations'],
    queryFn: async () => (await api.get<{ invitations: Invitation[] }>('/api/admin/invitations')).invitations,
  });
}

export interface NewInvitation {
  label?: string;
  maxUses: number;
  storageQuota: number | null;
  expiresAt?: string | null;
}

export function useCreateInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewInvitation) => api.post<{ invitation: Invitation }>('/api/admin/invitations', body),
    onSuccess: ({ invitation }) =>
      qc.setQueryData<Invitation[]>(['admin', 'invitations'], (list = []) => [invitation, ...list]),
  });
}

/** Revoke an invitation (`revoke: true`) or reactivate a revoked one. */
export function useRevokeInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, revoke }: { id: string; revoke: boolean }) =>
      api.post<{ invitation: Invitation }>(`/api/admin/invitations/${id}/${revoke ? 'revoke' : 'reactivate'}`, {}),
    onSuccess: ({ invitation }) =>
      qc.setQueryData<Invitation[]>(['admin', 'invitations'], (list) =>
        list?.map((i) => (i.id === invitation.id ? invitation : i)),
      ),
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

/** Rename a preset or style; fails if the user has another of that kind with the name. */
export function useRenamePreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.patch<Preset>(`/api/presets/${id}`, { name }),
    onSuccess: (preset) =>
      qc.setQueryData<Preset[]>(['presets'], (list = []) =>
        list.map((p) => (p.id === preset.id ? preset : p)).sort(byName),
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

// ── Export settings ─────────────────────────────────────────────────────────

interface ExportSettingsResponse {
  /** The last settings exported with, or null before the first export. */
  settings: ExportSettings | null;
  presets: ExportPreset[];
}

/** The user's last export settings and their export presets (nothing without an account). */
export function useExportSettings() {
  const { data: me } = useMe();
  return useQuery({
    queryKey: ['export-settings'],
    queryFn: () => api.get<ExportSettingsResponse>('/api/export-settings'),
    enabled: !!me,
    staleTime: Infinity,
  });
}

/** Remember the settings of an export, for the next one. */
export function useSaveLastExportSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (settings: ExportSettings) =>
      api.put<{ settings: ExportSettings }>('/api/export-settings', { settings }),
    onSuccess: ({ settings }) =>
      qc.setQueryData<ExportSettingsResponse>(['export-settings'], (data) => data && { ...data, settings }),
  });
}

const presetsOf = (qc: QueryClient, update: (presets: ExportPreset[]) => ExportPreset[]) =>
  qc.setQueryData<ExportSettingsResponse>(
    ['export-settings'],
    (data) => data && { ...data, presets: update(data.presets) },
  );

/** Save an export preset. One with the same name is replaced. */
export function useSaveExportPreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; settings: ExportSettings }) =>
      api.post<ExportPreset>('/api/export-presets', input),
    onSuccess: (preset) =>
      presetsOf(qc, (list) =>
        [...list.filter((p) => p.id !== preset.id), preset].sort((a, b) => a.name.localeCompare(b.name)),
      ),
  });
}

export function useDeleteExportPreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/export-presets/${id}`),
    onSuccess: (_, id) => presetsOf(qc, (list) => list.filter((p) => p.id !== id)),
  });
}
