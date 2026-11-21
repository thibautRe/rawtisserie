import type { EditParams, PhotoMetadata } from '@rawtisserie/pipeline';

export interface User {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
}

/** A user's original files against their quota, in bytes (`quota` null: unlimited). */
export interface StorageUsage {
  /** Everything stored, the trash included. */
  used: number;
  /** Of `used`, the originals whose versions are all in the trash. */
  trash: number;
  quota: number | null;
}

/** A user as the admin page lists them. */
export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
  isAdmin: boolean;
  storageQuota: number | null;
  storageUsed: number;
  photos: number;
  /** Label of the invitation the account was created with. */
  invitation: string | null;
}

/** The instance at a glance (admin overview); "recent" is the last 30 days. */
export interface AdminStats {
  users: { total: number; admins: number; recent: number; invited: number };
  /** `versions`: in libraries; `trashed`: in the trash. */
  photos: { total: number; recent: number; versions: number; trashed: number };
  /** `used` includes `trash`: originals whose versions are all in the trash. */
  storage: { used: number; trash: number; allocated: number; unlimitedUsers: number };
  renders: {
    pending: number;
    failed: number;
    /** How long the oldest waiting render has waited (0: none waiting). */
    oldestWaitMs: number;
    /** The last 24 hours: peak of pending renders, longest wait before a render started… */
    day: {
      peakPending: number;
      peakAt: string | null;
      maxWaitMs: number;
      renders: number;
      failures: number;
      averageMs: number | null;
    };
    week: { peakPending: number; maxWaitMs: number };
  };
  invitations: { active: number };
  instance: { storage: string; signup: 'open' | 'invitation'; defaultStorageQuota: number | null };
}

export type InvitationStatus = 'active' | 'used' | 'expired' | 'revoked';

export interface Invitation {
  id: string;
  code: string;
  label: string | null;
  maxUses: number;
  uses: number;
  storageQuota: number | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  createdBy: string | null;
  status: InvitationStatus;
}

export type Flag = 'picked' | 'rejected';
export const COLOR_LABELS = ['red', 'yellow', 'green', 'blue', 'purple'] as const;
export type ColorLabel = (typeof COLOR_LABELS)[number];

/**
 * A library item: one version of a photo (darktable's "duplicate"). `id` is the
 * version id; the file and its metadata belong to the photo and are shared by its versions.
 */
/** A version in the trash. */
export interface TrashItem extends Photo {
  trashedAt: string;
  /** When it will be deleted for good. */
  deleteAt: string;
  /** None of the photo's versions is left in the library: deleting this one may delete the original. */
  photoInTrash: boolean;
}

export interface TrashPage {
  versions: TrashItem[];
  total: number;
  /** The storage emptying the trash would free. */
  bytes: number;
  /** How long things stay in the trash. */
  days: number;
}

export interface Photo {
  id: string;
  photoId: string;
  /** The photo's collection (roadmap 8.14), if it's in one. */
  collectionId: string | null;
  /** Name of a duplicate; null for an unnamed version. */
  versionName: string | null;
  /** 1-based position among the photo's versions. */
  versionIndex: number;
  /** How many versions the photo has (a stack badge shows when there is more than one). */
  versionCount: number;
  filename: string;
  fileSize: number;
  /** The original's SHA-256: what a multiple exposure refers to it by. */
  sha256: string;
  cameraMake: string | null;
  cameraModel: string | null;
  lens: string | null;
  iso: number | null;
  exposureTime: number | null;
  fNumber: number | null;
  focalLength: number | null;
  exposureBias: number | null;
  capturedAt: string | null;
  width: number | null;
  height: number | null;
  gpsLatitude: number | null;
  gpsLongitude: number | null;
  artist: string | null;
  copyright: string | null;
  title: string | null;
  description: string | null;
  rating: number;
  flag: Flag | null;
  colorLabel: ColorLabel | null;
  tags: string[];
  edited: boolean;
  renderStatus: 'pending' | 'ready' | 'failed';
  renderError: string | null;
  thumbUrl: string | null;
  previewUrl: string | null;
  originalUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface HistoryEntry {
  seq: number;
  label: string;
  createdAt: string;
  /** The full recipe after this change. */
  recipe: EditParams;
}

/** One of the versions of a photo, for the version switcher. */
export interface VersionSummary {
  id: string;
  name: string | null;
  index: number;
  edited: boolean;
  thumbUrl: string | null;
}

export interface PhotoDetail extends Photo {
  exif: PhotoMetadata | null;
  /** The recipe at `historyEnd`, or null for the original. */
  editParams: EditParams | null;
  /** History entries 1…historyEnd are applied; 0 means no edits. */
  historyEnd: number;
  /** Bumped on every history change (optimistic concurrency). */
  revision: number;
  history: HistoryEntry[];
  /** Edits from another application it was imported with (a darktable sidecar), or null. */
  importedEdits: string | null;
  /** All versions of the photo, in order (this one included). */
  versions: VersionSummary[];
}

export type PhotoPatch = Partial<
  Pick<
    Photo,
    | 'versionName'
    | 'title'
    | 'description'
    | 'rating'
    | 'flag'
    | 'colorLabel'
    | 'tags'
    | 'cameraMake'
    | 'cameraModel'
    | 'lens'
    | 'iso'
    | 'exposureTime'
    | 'fNumber'
    | 'focalLength'
    | 'exposureBias'
    | 'capturedAt'
    | 'gpsLatitude'
    | 'gpsLongitude'
    | 'artist'
    | 'copyright'
  >
>;

export interface BulkPatch {
  rating?: number;
  flag?: Flag | null;
  colorLabel?: ColorLabel | null;
  addTags?: string[];
  removeTags?: string[];
}

export interface FacetValue<T = string> {
  value: T;
  count: number;
}

/** An import the library lists (newest first), with its versions under the other filters. */
export interface ImportFacet {
  value: string;
  count: number;
  importedAt: string;
  /** The instance it was sent from, or null for an upload. */
  source: string | null;
}

export interface Facets {
  imports: ImportFacet[];
  /** Each collection's own photos (not those under it) under the other filters; null for none. */
  collections: FacetValue<string | null>[];
  cameras: FacetValue[];
  lenses: FacetValue[];
  tags: FacetValue[];
  ratings: FacetValue<number>[];
  ranges: {
    total: number;
    capturedFrom: string | null;
    capturedTo: string | null;
    isoMin: number | null;
    isoMax: number | null;
    focalMin: number | null;
    focalMax: number | null;
    apertureMin: number | null;
    apertureMax: number | null;
    /** Versions without any tag. */
    untagged: number;
  };
}

/** Saved library filters (a filter preset). */
export interface FilterPreset {
  id: string;
  name: string;
  /** The filters, as the library's query string (no sort). */
  query: string;
}

/** A token made here, for another instance to send photos to this one. */
export interface AccessToken {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** Only when just made: shown once. */
  token?: string;
}

/** Another instance connected here, to send photos to. */
export interface RemoteInstance {
  id: string;
  url: string;
  /** The account its token is for. */
  account: string;
  createdAt: string;
}

/** Sending versions (or everything) to another instance, run by the server. */
export interface Transfer {
  id: string;
  url: string;
  everything: boolean;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  /** Why it stopped as a whole. */
  error: string | null;
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  waiting: number;
  /** Presets, styles and LUTs sent (with everything). */
  extrasSent: number;
  failures: { versionId: string; filename: string; error: string | null }[];
  createdAt: string;
  /** When it stopped (done, failed or cancelled). */
  finishedAt: string | null;
}

/**
 * What a library action applies to (roadmap 8.13): versions by id, or every version the
 * library's filters match (its query string), but those unticked since. The server
 * resolves a filter itself.
 */
export type Target = { ids: string[] } | { filter: string; except: string[] };
