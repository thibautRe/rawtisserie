import { normalizeEditParams } from '@rawtisserie/pipeline';
import type Photos from '../__generated__/photos.ts';

/** The JSON shape of a photo in the API. */
export function photoDto(p: Photos) {
  const v = p.render_version;
  return {
    id: p.id,
    filename: p.original_filename,
    fileSize: p.file_size,
    cameraMake: p.camera_make,
    cameraModel: p.camera_model,
    lens: p.lens,
    iso: p.iso,
    exposureTime: p.exposure_time,
    fNumber: p.f_number,
    focalLength: p.focal_length,
    exposureBias: p.exposure_bias,
    capturedAt: p.captured_at?.toISOString() ?? null,
    width: p.width,
    height: p.height,
    gpsLatitude: p.gps_latitude,
    gpsLongitude: p.gps_longitude,
    artist: p.artist,
    copyright: p.copyright,
    title: p.title,
    description: p.description,
    rating: p.rating,
    flag: p.flag,
    colorLabel: p.color_label,
    tags: p.tags.filter((t): t is string => t !== null),
    edited: p.edit_params !== null,
    renderStatus: p.render_status,
    renderError: p.render_error,
    thumbUrl: v > 0 ? `/api/photos/${p.id}/render/thumb?v=${v}` : null,
    previewUrl: v > 0 ? `/api/photos/${p.id}/render/preview?v=${v}` : null,
    originalUrl: `/api/photos/${p.id}/original`,
    createdAt: p.created_at.toISOString(),
    updatedAt: p.updated_at.toISOString(),
  };
}

export function photoDetailDto(p: Photos) {
  // Stored recipes may predate the current version; they are migrated on read.
  return { ...photoDto(p), exif: p.exif, editParams: p.edit_params && normalizeEditParams(p.edit_params) };
}
