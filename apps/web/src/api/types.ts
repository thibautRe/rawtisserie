import type { EditParams, PhotoMetadata } from '@rawtisserie/pipeline';

export interface User {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
}

/** A user's original files against their quota, in bytes (`quota` null: unlimited). */
export interface StorageUsage {
  used: number;
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
  photos: { total: number; recent: number; versions: number };
  storage: { used: number; allocated: number; unlimitedUsers: number };
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
export interface Photo {
  id: string;
  photoId: string;
  /** Name of a duplicate; null for an unnamed version. */
  versionName: string | null;
  /** 1-based position among the photo's versions. */
  versionIndex: number;
  /** How many versions the photo has (a stack badge shows when there is more than one). */
  versionCount: number;
  filename: string;
  fileSize: number;
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

export interface Facets {
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
  };
}
