/**
 * lensfun's database in the browser (roadmap 3.6): fetched once, when a photo could use
 * it (`mayUseLensfun`) or the lens picker opens. A static file with a hashed name, so
 * it's cached for good. Without it (offline, or not loaded yet), photos start without
 * lensfun's correction, as before.
 */
import {
  type EditParams,
  Lensfun,
  type LensfunDb,
  type PhotoMetadata,
  defaultRecipe,
  mayUseLensfun,
} from '@rawtisserie/pipeline';
import dbUrl from '@rawtisserie/pipeline/lensfun.json?url';

let loaded: Lensfun | null = null;
let loading: Promise<Lensfun> | null = null;

export function loadLensfun(): Promise<Lensfun> {
  loading ??= fetch(dbUrl)
    .then((res) => {
      if (!res.ok) throw new Error(`Lens database: ${res.status}`);
      return res.json() as Promise<LensfunDb>;
    })
    .then((db) => (loaded = new Lensfun(db)))
    .catch((err: unknown) => {
      loading = null;
      throw err;
    });
  return loading;
}

/** The database, if it's loaded. */
export const loadedLensfun = (): Lensfun | null => loaded;

/** Load the database if `metadata`'s default recipe could use it; never fails. */
export async function preloadLensfun(metadata: PhotoMetadata): Promise<void> {
  if (mayUseLensfun(metadata)) await loadLensfun().catch(() => null);
}

/** The recipe a new image starts with (`defaultRecipe`), with lensfun's correction when it's loaded. */
export const defaultRecipeFor = (metadata: PhotoMetadata): EditParams => defaultRecipe(metadata, loaded);
