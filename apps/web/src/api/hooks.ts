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
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { HistoryOp } from '../develop/history.ts';
import { type BatchEdit, runBatchEdit, undoBatchEdit } from '../library/batchEdit.ts';
import { toaster } from '../components/toaster.tsx';
import { ApiError, api } from './client.ts';
import { clearOriginals } from './originals.ts';
import { mergePages } from './pages.ts';
import type { Collection } from '../lib/collections.ts';
import type { Shortcut } from '../lib/keys.ts';
import type {
  AccessToken,
  AdminStats,
  AdminUser,
  BulkPatch,
  FacetValue,
  Facets,
  FilterPreset,
  Invitation,
  Photo,
  PhotoDetail,
  PhotoPatch,
  RemoteInstance,
  VersionListRequest,
  VersionPage,
  StorageUsage,
  Transfer,
  Target,
  TrashPage,
  User,
  ZoomInfo,
} from '@rawtisserie/api';

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

type PhotoPage = VersionPage;

/**
 * Versions changed from the library since its filters (`search`) were applied: listed
 * whether they still match or not, as the loupe does (a photo rejected under "Unflagged"
 * stays), until the filters are applied again (`useApplyFilters`, or other filters).
 */
let kept: { search: string; ids: string[] } = { search: '', ids: [] };

/** Keep these listed under `search` (call it before the change, which reads the list again). */
export function keepListed(search: string, ids: readonly string[]) {
  if (kept.search !== search) kept = { search, ids: [] };
  const added = ids.filter((id) => !kept.ids.includes(id));
  // The oldest go first past the server's limit.
  if (added.length) kept = { search, ids: [...kept.ids, ...added].slice(-MAX_KEPT) };
}

/** The versions kept under `search`, for a `Target` by filter. */
export const keptUnder = (search: string): { keep?: string[] } =>
  kept.search === search && kept.ids.length ? { keep: kept.ids } : {};

/** The server's limit (`MAX_KEPT`). */
const MAX_KEPT = 5000;

/** Cached library lists: `usePhotos`' pages in a row, or one of `useLibraryPhotos`' pages. */
type CachedPhotos = InfiniteData<PhotoPage> | PhotoPage;
const mapPages = (data: CachedPhotos | undefined, f: (page: PhotoPage) => PhotoPage) =>
  !data ? data : 'pages' in data ? { ...data, pages: data.pages.map(f) } : f(data);

/** The ids of the versions a selection by filter holds, in the library's order (roadmap 8.13). */
export async function fetchTargetIds(target: Target): Promise<string[]> {
  if ('ids' in target) return target.ids;
  return (await api.post<{ ids: string[] }>('/api/versions/ids', target)).ids;
}

/** The photos a selection by filter holds, in the library's order: pages of the most the server gives. */
export async function fetchTargetPhotos(target: Extract<Target, { filter: string }>): Promise<Photo[]> {
  const except = new Set(target.except);
  const photos: Photo[] = [];
  for (let offset = 0; ; offset += 500) {
    const params = new URLSearchParams(target.filter);
    params.set('limit', '500');
    params.set('offset', String(offset));
    const page = target.keep?.length
      ? await api.post<PhotoPage>('/api/versions/list', { query: params.toString(), keep: target.keep })
      : await api.get<PhotoPage>(`/api/versions?${params}`);
    photos.push(...page.versions.filter((p) => !except.has(p.id)));
    if (!page.versions.length || offset + page.versions.length >= page.total) return photos;
  }
}

const fetchPage = (search: string, offset: number) => {
  const params = new URLSearchParams(search);
  params.set('limit', String(PAGE_SIZE));
  params.set('offset', String(offset));
  const { keep } = keptUnder(search);
  if (!keep) return api.get<PhotoPage>(`/api/versions?${params}`);
  const body: VersionListRequest = { query: params.toString(), keep };
  return api.post<PhotoPage>('/api/versions/list', body);
};

/**
 * The library's photos at any position, for a grid that reserves room for all of them:
 * `items` has one slot per photo, undefined until its page is in. `want` asks for the
 * pages holding a range of positions (those on screen); the first one always is.
 */
export function useLibraryPhotos(search: string) {
  // Other filters: what was kept under the last ones goes.
  if (kept.search !== search) kept = { search, ids: [] };
  return usePagedVersions(['photos', search], (offset) => fetchPage(search, offset));
}

/** Apply the library's filters again: the photos kept since (`keepListed`) that no longer match go. */
export function useApplyFilters() {
  const qc = useQueryClient();
  return useCallback(
    (search: string) => {
      if (kept.search === search) kept = { search, ids: [] };
      void qc.invalidateQueries({ queryKey: ['photos', search] });
    },
    [qc],
  );
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
  const { items, total, latest, stale } = useMemo(() => {
    const loaded = pages.flatMap((page, i) => {
      const d = datas[i];
      return d ? [{ page, versions: d.versions, total: d.total, updatedAt: updated[i]! }] : [];
    });
    const merged = mergePages<P['versions'][number]>(loaded, PAGE_SIZE);
    const latest = merged.latest && datas[pages.indexOf(merged.latest.page)];
    return { ...merged, latest };
    // Any change of a page's data changes its update time.
  }, [pages.join(), updated.join()]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pages fetched before the list changed (an import going on): fetched again, so their
  // slots show what's there now.
  useEffect(() => {
    for (const page of stale) {
      const r = results[pages.indexOf(page)];
      if (r && !r.isFetching) void r.refetch();
    }
  }, [stale.join()]); // eslint-disable-line react-hooks/exhaustive-deps

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
/** For managing tags: every level with its photos, and the user's own tags. */
export interface TagManagerData {
  levels: { value: string; photos: number; trashed: number }[];
  own: { tag: string; shortcut: Shortcut | null }[];
}

export function useTagManager() {
  return useQuery({ queryKey: ['tags', 'manage'], queryFn: () => api.get<TagManagerData>('/api/tags/manage') });
}

/** The user's tag shortcuts (`useTagShortcuts`). */
export function useOwnTags(enabled = true) {
  return useQuery({
    queryKey: ['tags', 'manage'],
    queryFn: () => api.get<TagManagerData>('/api/tags/manage'),
    select: (d) => d.own,
    staleTime: 60_000,
    enabled,
  });
}

export type TagChange =
  | { type: 'create'; tag: string }
  | { type: 'rename'; from: string; to: string }
  | { type: 'delete'; tag: string }
  | { type: 'shortcut'; tag: string; shortcut: Shortcut | null };

/** A change to the tags (the Tags filter's menus): what shows tags is read again. Answers the versions changed. */
export function useTagChange() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (c: TagChange): Promise<number> => {
      if (c.type === 'create') await api.post('/api/tags', { tag: c.tag });
      else if (c.type === 'shortcut') await api.put('/api/tags/shortcut', { tag: c.tag, shortcut: c.shortcut });
      else if (c.type === 'rename')
        return (await api.post<{ versions: number }>('/api/tags/rename', { from: c.from, to: c.to })).versions;
      else return (await api.post<{ versions: number }>('/api/tags/delete', { tag: c.tag })).versions;
      return 0;
    },
    onSuccess: (_, c) => {
      void qc.invalidateQueries({ queryKey: ['tags'] });
      void qc.invalidateQueries({ queryKey: ['facets'] });
      if (c.type === 'rename' || c.type === 'delete') {
        void qc.invalidateQueries({ queryKey: ['photos'] });
        void qc.invalidateQueries({ queryKey: ['photo'] });
        void qc.invalidateQueries({ queryKey: ['trash'] });
        // Saved filters follow the tag.
        void qc.invalidateQueries({ queryKey: ['filter-presets'] });
      }
    },
  });
}

/** The user's collections (roadmap 8.14). Under `facets`, so library changes (imports) refresh their counts. */
export function useCollections() {
  return useQuery({
    queryKey: ['facets', 'collections'],
    queryFn: () => api.get<Collection[]>('/api/collections'),
    staleTime: 30_000,
  });
}

export type CollectionChange =
  | { type: 'create'; name: string; parentId: string | null }
  | { type: 'rename'; id: string; name: string }
  | { type: 'move'; id: string; parentId: string | null }
  | { type: 'merge'; id: string; into: string }
  | { type: 'delete'; id: string };

/** Make, rename, move, merge or delete a collection. A new one comes back. */
export function useCollectionChange() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (c: CollectionChange): Promise<Collection | null> => {
      if (c.type === 'create') return api.post<Collection>('/api/collections', { name: c.name, parentId: c.parentId });
      if (c.type === 'rename') await api.patch(`/api/collections/${c.id}`, { name: c.name });
      else if (c.type === 'move') await api.patch(`/api/collections/${c.id}`, { parentId: c.parentId });
      else if (c.type === 'merge') await api.post(`/api/collections/${c.id}/merge`, { into: c.into });
      else await api.delete(`/api/collections/${c.id}`);
      return null;
    },
    onSuccess: (_, c) => {
      void qc.invalidateQueries({ queryKey: ['facets'] });
      // Photos carry their collection: merged or deleted ones changed.
      if (c.type === 'merge' || c.type === 'delete') {
        void qc.invalidateQueries({ queryKey: ['photos'] });
        void qc.invalidateQueries({ queryKey: ['photo'] });
      }
    },
  });
}

/** Put the photos of versions (`target`) in a collection (null: none). Answers how many photos moved. */
export function useMoveToCollection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ target, collectionId }: { target: Target; collectionId: string | null }) =>
      (await api.post<{ count: number }>('/api/versions/collection', { ...target, collectionId })).count,
    onSettled: () => refreshVersions(qc),
  });
}

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

/**
 * Rate, flag, label or tag versions: `ids`, changed in the cache at once, or with `target`
 * all a filter matches (`ids` are then those of them the library shows).
 */
export function useBulkUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, target, patch }: { ids: string[]; target?: Target; patch: BulkPatch }) =>
      api.post<{ versions: Photo[]; count: number }>('/api/versions/bulk', { ...(target ?? { ids }), patch }),
    onMutate: ({ ids, patch }) => {
      // A list being read again (after the last change) would bring the old values back
      // over this one: a second toggle would then undo the first again. Cancelled now,
      // without reverting (that would undo this change too, a moment later), and the
      // cache changed at once (the loupe reads it as it renders).
      void qc.cancelQueries({ queryKey: ['photos'] }, { revert: false });
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
    mutationFn: (target: Target) => api.post<{ trashed: string[] }>('/api/versions/delete', target),
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

// ── Filter presets ──────────────────────────────────────────────────────────

const byPresetName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

/** The user's saved library filters. */
export function useFilterPresets() {
  return useQuery({
    queryKey: ['filter-presets'],
    queryFn: async () => (await api.get<{ presets: FilterPreset[] }>('/api/filter-presets')).presets,
    staleTime: Infinity,
  });
}

/** Save the filters under a name. One with the same name is replaced. */
export function useSaveFilterPreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; query: string }) => api.post<FilterPreset>('/api/filter-presets', input),
    onSuccess: (preset) =>
      qc.setQueryData<FilterPreset[]>(['filter-presets'], (list = []) =>
        [...list.filter((p) => p.id !== preset.id), preset].sort(byPresetName),
      ),
  });
}

export function useRenameFilterPreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api.patch<FilterPreset>(`/api/filter-presets/${id}`, { name }),
    onSuccess: (preset) =>
      qc.setQueryData<FilterPreset[]>(['filter-presets'], (list = []) =>
        list.map((p) => (p.id === preset.id ? preset : p)).sort(byPresetName),
      ),
  });
}

export function useDeleteFilterPreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/filter-presets/${id}`),
    onSuccess: (_, id) =>
      qc.setQueryData<FilterPreset[]>(['filter-presets'], (list = []) => list.filter((p) => p.id !== id)),
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

// ── Other instances (sending photos there, receiving from there) ────────────

export function useAccessTokens() {
  return useQuery({
    queryKey: ['access-tokens'],
    queryFn: async () => (await api.get<{ tokens: AccessToken[] }>('/api/access-tokens')).tokens,
  });
}

export function useCreateAccessToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.post<AccessToken>('/api/access-tokens', { name }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['access-tokens'] }),
  });
}

export function useRevokeAccessToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/access-tokens/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['access-tokens'] }),
  });
}

export function useInstances() {
  return useQuery({
    queryKey: ['instances'],
    queryFn: async () => (await api.get<{ instances: RemoteInstance[] }>('/api/instances')).instances,
    staleTime: 60_000,
  });
}

export function useConnectInstance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { url: string; token: string }) => api.post<RemoteInstance>('/api/instances', body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['instances'] }),
  });
}

export function useDisconnectInstance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/instances/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['instances'] }),
  });
}

/** Start sending versions (`ids`) or everything to an instance. */
export const sendToInstance = (instanceId: string, what: Target | { everything: true }) =>
  api.post<Transfer>(`/api/instances/${instanceId}/send`, what);

/** A transfer, polled while it runs. */
export function useTransfer(id: string) {
  return useQuery({
    queryKey: ['transfer', id],
    queryFn: () => api.get<Transfer>(`/api/transfers/${id}`),
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 1000 : false),
  });
}

export function useRetryTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<Transfer>(`/api/transfers/${id}/retry`),
    onSuccess: (t) => qc.setQueryData(['transfer', t.id], t),
  });
}

export function useCancelTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<Transfer>(`/api/transfers/${id}/cancel`),
    onSuccess: (t) => qc.setQueryData(['transfer', t.id], t),
  });
}
