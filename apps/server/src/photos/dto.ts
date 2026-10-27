import { normalizeEditParams } from '@rawtisserie/pipeline';
import { sql } from '../db.ts';
import type HistoryEntries from '../__generated__/history_entries.ts';
import type Photos from '../__generated__/photos.ts';
import type Versions from '../__generated__/versions.ts';

/** `versions v JOIN photos p`: what the library lists. */
export const VERSIONS_FROM = sql`versions v JOIN photos p ON p.id = v.photo_id`;

/** A version together with the columns of its photo it is displayed with. */
export type VersionRow = Versions &
  Pick<
    Photos,
    | 'owner_id'
    | 'original_filename'
    | 'file_size'
    | 'camera_make'
    | 'camera_model'
    | 'lens'
    | 'iso'
    | 'exposure_time'
    | 'f_number'
    | 'focal_length'
    | 'exposure_bias'
    | 'captured_at'
    | 'width'
    | 'height'
    | 'gps_latitude'
    | 'gps_longitude'
    | 'artist'
    | 'copyright'
  > & { version_count: number };

export const VERSION_COLUMNS = sql`v.*, p.owner_id, p.original_filename, p.file_size, p.camera_make, p.camera_model,
  p.lens, p.iso, p.exposure_time, p.f_number, p.focal_length, p.exposure_bias, p.captured_at, p.width, p.height,
  p.gps_latitude, p.gps_longitude, p.artist, p.copyright,
  (SELECT count(*)::int FROM versions s WHERE s.photo_id = v.photo_id) AS version_count`;

/** The JSON shape of a library item (one version of a photo) in the API. */
export function versionDto(v: VersionRow) {
  const r = v.render_version;
  return {
    id: v.id,
    photoId: v.photo_id,
    versionName: v.name,
    versionCount: v.version_count,
    filename: v.original_filename,
    fileSize: v.file_size,
    cameraMake: v.camera_make,
    cameraModel: v.camera_model,
    lens: v.lens,
    iso: v.iso,
    exposureTime: v.exposure_time,
    fNumber: v.f_number,
    focalLength: v.focal_length,
    exposureBias: v.exposure_bias,
    capturedAt: v.captured_at?.toISOString() ?? null,
    width: v.width,
    height: v.height,
    gpsLatitude: v.gps_latitude,
    gpsLongitude: v.gps_longitude,
    artist: v.artist,
    copyright: v.copyright,
    title: v.title,
    description: v.description,
    rating: v.rating,
    flag: v.flag,
    colorLabel: v.color_label,
    tags: v.tags.filter((t): t is string => t !== null),
    edited: v.history_end > 0,
    renderStatus: v.render_status,
    renderError: v.render_error,
    thumbUrl: r > 0 ? `/api/versions/${v.id}/render/thumb?v=${r}` : null,
    previewUrl: r > 0 ? `/api/versions/${v.id}/render/preview?v=${r}` : null,
    originalUrl: `/api/photos/${v.photo_id}/original`,
    createdAt: v.created_at.toISOString(),
    updatedAt: v.updated_at.toISOString(),
  };
}

export function versionDetailDto(
  v: VersionRow,
  photo: Pick<Photos, 'exif'>,
  history: Pick<HistoryEntries, 'seq' | 'label' | 'created_at' | 'recipe'>[],
) {
  const current = history.find((h) => h.seq === v.history_end);
  return {
    ...versionDto(v),
    exif: photo.exif,
    // Stored recipes may predate the current version; they are migrated on read.
    editParams: current ? normalizeEditParams(current.recipe) : null,
    historyEnd: v.history_end,
    revision: v.revision,
    history: history.map((h) => ({ seq: h.seq, label: h.label, createdAt: h.created_at.toISOString() })),
  };
}
