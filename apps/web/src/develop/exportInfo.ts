import type { ExportMetadata, FilenameFields, PhotoMetadata } from '@rawtisserie/pipeline';
import type { Photo } from '@rawtisserie/api';

/** What an export knows about the photo: its file's metadata, and what file names can use. */
export interface ExportInfo {
  metadata: ExportMetadata;
  filename: FilenameFields;
}

/** A file opened from disk: its own metadata, no curation. */
export function fileExportInfo(filename: string, metadata: PhotoMetadata): ExportInfo {
  return {
    metadata: { photo: metadata, title: null, description: null, rating: 0, label: null, tags: [] },
    filename: {
      filename,
      versionName: null,
      versionIndex: 1,
      versionCount: 1,
      title: null,
      capturedAt: metadata.capturedAt,
      camera: metadata.model,
      lens: metadata.lensModel,
      iso: metadata.iso,
      rating: 0,
    },
  };
}

/**
 * A library version: the file's metadata with the library's corrections (camera,
 * exposure, date, location, artist…), and the version's curation.
 */
export function photoExportInfo(photo: Photo, metadata: PhotoMetadata): ExportInfo {
  const corrected: PhotoMetadata = {
    ...metadata,
    make: photo.cameraMake,
    model: photo.cameraModel,
    lensModel: photo.lens,
    iso: photo.iso,
    exposureTime: photo.exposureTime,
    fNumber: photo.fNumber,
    focalLength: photo.focalLength,
    exposureBias: photo.exposureBias,
    capturedAt: photo.capturedAt,
    gpsLatitude: photo.gpsLatitude,
    gpsLongitude: photo.gpsLongitude,
    // A corrected position makes the file's altitude meaningless.
    gpsAltitude:
      photo.gpsLatitude === metadata.gpsLatitude && photo.gpsLongitude === metadata.gpsLongitude
        ? metadata.gpsAltitude
        : null,
    artist: photo.artist,
    copyright: photo.copyright,
  };
  return {
    metadata: {
      photo: corrected,
      title: photo.title,
      description: photo.description,
      rating: photo.rating,
      label: photo.colorLabel,
      tags: photo.tags,
    },
    filename: photoFilenameFields(photo),
  };
}

/** What a library version's file names can refer to (the library's values, corrections included). */
export function photoFilenameFields(photo: Photo): FilenameFields {
  return {
    filename: photo.filename,
    versionName: photo.versionName,
    versionIndex: photo.versionIndex,
    versionCount: photo.versionCount,
    title: photo.title,
    capturedAt: photo.capturedAt,
    camera: photo.cameraModel,
    lens: photo.lens,
    iso: photo.iso,
    rating: photo.rating,
  };
}
