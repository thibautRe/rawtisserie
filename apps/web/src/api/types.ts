import type { EditParams, PhotoMetadata } from '@rawtisserie/pipeline';

export interface User {
  id: string;
  email: string;
  displayName: string;
}

export type Flag = 'picked' | 'rejected';
export const COLOR_LABELS = ['red', 'yellow', 'green', 'blue', 'purple'] as const;
export type ColorLabel = (typeof COLOR_LABELS)[number];

export interface Photo {
  id: string;
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

export interface PhotoDetail extends Photo {
  exif: PhotoMetadata | null;
  editParams: EditParams | null;
}

export type PhotoPatch = Partial<
  Pick<
    Photo,
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
