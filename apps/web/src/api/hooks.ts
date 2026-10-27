import type { EditParams } from '@rawtisserie/pipeline';
import {
  type InfiniteData,
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
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

export function useUpdatePhoto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: PhotoPatch }) => api.patch<PhotoDetail>(`/api/versions/${id}`, patch),
    onMutate: ({ id, patch }) => updateCachedPhotos(qc, [id], (p) => ({ ...p, ...patch })),
    onSuccess: (photo) => {
      qc.setQueryData(['photo', photo.id], photo);
      updateCachedPhotos(qc, [photo.id], (p) => ({ ...p, ...photo }));
    },
    // Metadata belongs to the photo: other versions of it change too.
    onSettled: () => refreshLibrary(qc),
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
    onSettled: () => refreshLibrary(qc),
  });
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

/** Record a recipe as the version's next history entry. */
export function useSaveEdit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, params, baseRevision }: { id: string; params: EditParams; baseRevision?: number }) =>
      api.post<PhotoDetail>(`/api/versions/${id}/history`, { recipe: params, baseRevision }),
    onSuccess: (photo) => {
      qc.setQueryData(['photo', photo.id], photo);
      refreshLibrary(qc);
    },
  });
}
