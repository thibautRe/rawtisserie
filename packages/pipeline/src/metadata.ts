/** Metadata extracted from a RAW file (or an image: `imageFormat`). Mirrors `PhotoMetadata` in `crates/pipeline/src/metadata.rs`. */
export interface PhotoMetadata {
  make: string | null;
  model: string | null;
  lensMake: string | null;
  lensModel: string | null;
  iso: number | null;
  /** Seconds. */
  exposureTime: number | null;
  fNumber: number | null;
  /** Millimetres. */
  focalLength: number | null;
  /** EV. */
  exposureBias: number | null;
  /** ISO 8601 local date-time, with offset when the camera recorded one. */
  capturedAt: string | null;
  width: number | null;
  height: number | null;
  orientation: number | null;
  artist: string | null;
  copyright: string | null;
  serialNumber: string | null;
  rating: number | null;
  flash: number | null;
  meteringMode: number | null;
  exposureProgram: number | null;
  gpsLatitude: number | null;
  gpsLongitude: number | null;
  gpsAltitude: number | null;
  /** Where the lens correction data embedded in the file comes from (`"sony"`), if it has any. */
  lensCorrection?: string | null;
  /** CIE 1931 xy chromaticity of the light the camera's white balance was set for (colour calibration's "as shot"). */
  asShotIlluminant?: [number, number] | null;
  /**
   * For an image that isn't a RAW file (developed already: `"jpeg"`, `"png"`, `"tiff"`,
   * `"webp"`), its format. Such a photo starts with an empty recipe and has no filmic or
   * lens correction (`RAW_ONLY_KINDS`).
   */
  imageFormat?: string | null;
}

/** `0.004` → `"1/250"`, `2.5` → `"2.5″"`. */
export function formatExposureTime(seconds: number | null | undefined): string | null {
  if (seconds == null || !(seconds > 0)) return null;
  if (seconds >= 0.3) return `${Number(seconds.toFixed(1))}″`;
  return `1/${Math.round(1 / seconds)}`;
}
