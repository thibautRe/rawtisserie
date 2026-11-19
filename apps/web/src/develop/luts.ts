/**
 * Creative LUTs in the developer (roadmap 4.8): the built-in ones, the user's (on the
 * server with an account, in this browser's IndexedDB without one), and their tables,
 * fetched once per page for the render backend (`RenderBackend.setLutSource`).
 */
import { BUILTIN_LUTS, type UserLut, freeLutName } from '@rawtisserie/pipeline';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, useSyncExternalStore, useEffect } from 'react';
import { ApiError, api } from '../api/client.ts';
import { useMe } from '../api/hooks.ts';
import type { ParsedLut } from './protocol.ts';
import { useStableCallback } from './useStableCallback.ts';

/** A LUT the menu offers. */
export interface LutChoice {
  /** The table's id: what recipes refer to. */
  id: string;
  name: string;
  description: string | null;
  builtIn: boolean;
  /** Who made it (built-in ones). */
  credit: string | null;
  /** A user's LUT on the server: the id of their copy. */
  copyId: string | null;
}

/** What the LUT file picker accepts. */
export const LUT_ACCEPT = '.cube,.png,image/png';

const BUILTIN_CHOICES: readonly LutChoice[] = BUILTIN_LUTS.filter((l) => !l.retired).map((l) => ({
  id: l.id,
  name: l.name,
  description: l.description,
  builtIn: true,
  credit: l.credit,
  copyId: null,
}));

// ── This browser's LUTs (without an account) ─────────────────────────────────

interface LocalLut {
  id: string;
  name: string;
  packed: ArrayBuffer;
  createdAt: string;
}

let database: Promise<IDBDatabase> | null = null;
function openDatabase(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('rawtisserie-luts', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('luts', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB unavailable'));
  });
  return database;
}

function localRequest<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = run(db.transaction('luts', mode).objectStore('luts'));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
      }),
  );
}

const localList = () => localRequest<LocalLut[]>('readonly', (s) => s.getAll());
const localGet = (id: string) =>
  localRequest<LocalLut | undefined>('readonly', (s) => s.get(id)).catch(() => undefined);
const localPut = (lut: LocalLut) => localRequest<unknown>('readwrite', (s) => s.put(lut));
const localDelete = (id: string) => localRequest<unknown>('readwrite', (s) => s.delete(id));

// ── Tables ───────────────────────────────────────────────────────────────────

const tables = new Map<string, Promise<ArrayBuffer | null>>();
/** LUTs whose table couldn't be had, for the warning in the module. */
let missing: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
function setMissing(id: string, isMissing: boolean) {
  if (missing.has(id) === isMissing) return;
  const next = new Set(missing);
  if (isMissing) next.add(id);
  else next.delete(id);
  missing = next;
  for (const l of listeners) l();
}

async function fetchTable(id: string): Promise<ArrayBuffer | null> {
  const local = await localGet(id);
  if (local) return local.packed;
  const res = await fetch(`/api/luts/${id}/data`, { credentials: 'same-origin' });
  if (res.status === 404 || res.status === 401) return null;
  if (!res.ok) throw new ApiError(res.status, res.statusText);
  return res.arrayBuffer();
}

/** A LUT's packed table, fetched once; null if it can't be had (asked again next time). */
export function lutTable(id: string): Promise<ArrayBuffer | null> {
  let table = tables.get(id);
  if (!table) {
    table = fetchTable(id).catch(() => null);
    tables.set(id, table);
    void table.then((bytes) => {
      if (!bytes) tables.delete(id);
      setMissing(id, !bytes);
    });
  }
  return table;
}

/** The LUTs whose table couldn't be had (so far). */
export function useMissingLuts(): ReadonlySet<string> {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => missing,
  );
}

// ── The library ──────────────────────────────────────────────────────────────

export interface LutLibrary {
  builtIn: readonly LutChoice[];
  /** The user's, by name. Each list keeps its identity until it changes. */
  own: readonly LutChoice[];
  /** Kept in this browser (no account) rather than on the server. */
  local: boolean;
  /** Store a decoded file as the user's, named `name` (or `name (2)`… if taken). */
  add: (parsed: ParsedLut, name: string) => Promise<LutChoice>;
  /** Rename one of the user's LUTs; rejects if they already have one with that name. */
  rename: (lut: LutChoice, name: string) => Promise<void>;
  /** Take a LUT off the user's list. Recipes that use it keep it (on the server). */
  remove: (lut: LutChoice) => Promise<void>;
}

const userLutChoice = (l: UserLut): LutChoice => ({
  id: l.lutId,
  name: l.name,
  description: null,
  builtIn: false,
  credit: null,
  copyId: l.id,
});

const byName = (a: LutChoice, b: LutChoice) => a.name.localeCompare(b.name);

/**
 * The user's LUTs by name, for edits imported from another application that refer to
 * them (`ImportContext.luts`): undefined while loading, none without an account.
 */
export function useUserLutNames(): readonly { id: string; name: string }[] | undefined {
  const { data: me, isPending } = useMe();
  const { data } = useQuery({
    queryKey: ['luts'],
    queryFn: async () => (await api.get<{ luts: UserLut[] }>('/api/luts')).luts,
    enabled: !!me,
    staleTime: Infinity,
  });
  return useMemo(() => {
    if (isPending) return undefined;
    if (!me) return [];
    return data?.map((l) => ({ id: l.lutId, name: l.name }));
  }, [isPending, me, data]);
}

export function useLutLibrary(): LutLibrary {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const local = !me;
  const { data: server } = useQuery({
    queryKey: ['luts'],
    queryFn: async () => (await api.get<{ luts: UserLut[] }>('/api/luts')).luts,
    enabled: !!me,
    staleTime: Infinity,
  });
  const [localLuts, setLocalLuts] = useState<LocalLut[] | null>(null);
  useEffect(() => {
    if (!local) return;
    localList()
      .then(setLocalLuts)
      .catch(() => setLocalLuts([]));
  }, [local]);

  const own = useMemo(
    () =>
      local
        ? (localLuts ?? [])
            .map((l): LutChoice => ({ ...userLutChoice({ ...l, lutId: l.id, size: 0, bitDepth: 0 }), copyId: null }))
            .sort(byName)
        : (server ?? []).map(userLutChoice),
    [local, localLuts, server],
  );

  const add = useStableCallback(async (parsed: ParsedLut, name: string): Promise<LutChoice> => {
    const taken = own.filter((l) => l.id !== parsed.lutId).map((l) => l.name);
    const free = freeLutName(name.trim().slice(0, 200) || 'LUT', taken);
    let choice: LutChoice;
    if (local) {
      const lut = { id: parsed.lutId, name: free, packed: parsed.packed, createdAt: new Date().toISOString() };
      await localPut(lut);
      setLocalLuts((list) => [...(list ?? []).filter((l) => l.id !== lut.id), lut]);
      choice = { ...userLutChoice({ ...lut, lutId: lut.id, size: 0, bitDepth: 0 }), copyId: null };
    } else {
      const res = await fetch(`/api/luts?name=${encodeURIComponent(free)}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/octet-stream' },
        body: parsed.packed,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText);
      const lut = data as UserLut;
      qc.setQueryData<UserLut[]>(['luts'], (list = []) =>
        [...list.filter((l) => l.id !== lut.id), lut].sort((a, b) => a.name.localeCompare(b.name)),
      );
      choice = userLutChoice(lut);
    }
    // The renderers will ask for it at once.
    tables.set(parsed.lutId, Promise.resolve(parsed.packed));
    setMissing(parsed.lutId, false);
    return choice;
  });

  const rename = useStableCallback(async (lut: LutChoice, name: string) => {
    const wanted = name.trim().slice(0, 200);
    if (!wanted) throw new Error('A LUT needs a name');
    if (local) {
      // The server checks this for its own (ignoring case, like `freeLutName`).
      if (own.some((l) => l.id !== lut.id && l.name.toLowerCase() === wanted.toLowerCase()))
        throw new Error(`There is already a LUT named “${wanted}”`);
      const stored = await localGet(lut.id);
      if (!stored) throw new Error('This LUT is no longer in this browser');
      const renamed = { ...stored, name: wanted };
      await localPut(renamed);
      setLocalLuts((list) => (list ?? []).map((l) => (l.id === lut.id ? renamed : l)));
    } else if (lut.copyId) {
      const renamed = await api.patch<UserLut>(`/api/luts/${lut.copyId}`, { name: wanted });
      qc.setQueryData<UserLut[]>(['luts'], (list = []) =>
        list.map((l) => (l.id === renamed.id ? renamed : l)).sort((a, b) => a.name.localeCompare(b.name)),
      );
    }
  });

  const remove = useStableCallback(async (lut: LutChoice) => {
    if (local) {
      await localDelete(lut.id);
      setLocalLuts((list) => (list ?? []).filter((l) => l.id !== lut.id));
    } else if (lut.copyId) {
      await api.delete(`/api/luts/${lut.copyId}`);
      qc.setQueryData<UserLut[]>(['luts'], (list = []) => list.filter((l) => l.id !== lut.copyId));
    }
  });

  return useMemo(
    () => ({ builtIn: BUILTIN_CHOICES, own, local, add, rename, remove }),
    [own, local, add, rename, remove],
  );
}
