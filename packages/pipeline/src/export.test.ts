import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_EXPORT_SETTINGS,
  type ExportMetadata,
  type ExportSettings,
  type FilenameFields,
  exportFilename,
  exportOptions,
  normalizeExportSettings,
} from './export.ts';
import { DEFAULT_FRAME } from './frame.ts';
import type { PhotoMetadata } from './metadata.ts';
import { initPipeline, normalizeExport } from './node.ts';

const photo: PhotoMetadata = {
  make: 'Sony',
  model: 'ILCE-7M4',
  lensMake: 'Sony',
  lensModel: 'FE 24-70mm F2.8 GM II',
  iso: 400,
  exposureTime: 0.004,
  fNumber: 2.8,
  focalLength: 35,
  exposureBias: -0.7,
  capturedAt: '2024-05-01T12:34:56+02:00',
  width: 7008,
  height: 4672,
  orientation: 1,
  artist: 'Ada',
  copyright: '© Ada',
  serialNumber: '1234',
  rating: 2,
  flash: 16,
  meteringMode: 5,
  exposureProgram: 3,
  gpsLatitude: 48.85,
  gpsLongitude: 2.35,
  gpsAltitude: 35,
  lensCorrection: 'sony',
  asShotIlluminant: [0.3127, 0.329],
  imageFormat: null,
};

const settings: ExportSettings[] = [
  DEFAULT_EXPORT_SETTINGS,
  {
    ...DEFAULT_EXPORT_SETTINGS,
    format: 'tiff',
    depth: 16,
    colorSpace: 'displayP3',
    size: { ...DEFAULT_EXPORT_SETTINGS.size, mode: 'fit', width: 1200, height: 0 },
    sharpening: 'standard',
    metadata: 'noLocation',
    framed: true,
    frame: { ...DEFAULT_FRAME, size: 0.1, aspect: 1.25, orientation: 'portrait', position: [0.25, 1], line: 0.005 },
  },
  {
    ...DEFAULT_EXPORT_SETTINGS,
    format: 'png',
    depth: 8,
    colorSpace: 'rec2020',
    size: { ...DEFAULT_EXPORT_SETTINGS.size, mode: 'megapixels', megapixels: 2.5 },
  },
  {
    ...DEFAULT_EXPORT_SETTINGS,
    colorSpace: 'adobeRgb',
    size: { ...DEFAULT_EXPORT_SETTINGS.size, mode: 'shortEdge' },
    metadata: 'copyright',
  },
  {
    ...DEFAULT_EXPORT_SETTINGS,
    quality: 75,
    size: { ...DEFAULT_EXPORT_SETTINGS.size, mode: 'longEdge' },
    metadata: 'none',
  },
];

test('Rust reads export options and metadata unchanged', () => {
  initPipeline();
  const metadata: ExportMetadata = {
    photo,
    title: 'Harbour',
    description: null,
    rating: 4,
    label: 'red',
    tags: ['night', 'sea'],
  };
  for (const s of settings) {
    const options = exportOptions(s);
    const [rustOptions, rustMetadata] = normalizeExport(JSON.stringify(options), JSON.stringify(metadata));
    assert.deepEqual(JSON.parse(rustOptions!), options);
    assert.deepEqual(JSON.parse(rustMetadata!), metadata);
  }
});

test('JPEG options are 8 bits', () => {
  assert.equal(exportOptions({ ...DEFAULT_EXPORT_SETTINGS, depth: 16 }).depth, 8);
  assert.equal(exportOptions({ ...DEFAULT_EXPORT_SETTINGS, format: 'png', depth: 16 }).depth, 16);
});

test('settings normalise', () => {
  assert.deepEqual(normalizeExportSettings(undefined), DEFAULT_EXPORT_SETTINGS);
  assert.deepEqual(normalizeExportSettings(DEFAULT_EXPORT_SETTINGS), DEFAULT_EXPORT_SETTINGS);
  for (const s of settings) assert.deepEqual(normalizeExportSettings(JSON.parse(JSON.stringify(s))), s);
  const bad = normalizeExportSettings({
    format: 'gif',
    quality: 400,
    depth: 12,
    colorSpace: 'cmyk',
    size: { mode: 'fit', width: -5, height: 'x', megapixels: 0 },
    frame: { color: 'red', position: [2] },
    filename: '   ',
  });
  assert.equal(bad.format, 'jpeg');
  assert.equal(bad.quality, 100);
  assert.equal(bad.depth, 16);
  assert.equal(bad.colorSpace, 'srgb');
  assert.deepEqual([bad.size.mode, bad.size.width, bad.size.height, bad.size.megapixels], ['fit', 0, 1080, 0.01]);
  assert.deepEqual([bad.frame.color, bad.frame.position], ['#ffffff', [1, 0.5]]);
  assert.equal(bad.filename, '{name}');
});

test('settings from the old export dialog', () => {
  const old = { size: 'custom', customSize: '1600', quality: 85, framed: true, frame: { size: 0.1 } };
  const s = normalizeExportSettings(old);
  assert.deepEqual(
    [s.size.mode, s.size.longEdge, s.quality, s.framed, s.frame.size],
    ['longEdge', 1600, 85, true, 0.1],
  );
  assert.equal(normalizeExportSettings({ size: '0' }).size.mode, 'full');
  assert.deepEqual(
    [normalizeExportSettings({ size: '2048' }).size.mode, normalizeExportSettings({ size: '2048' }).size.longEdge],
    ['longEdge', 2048],
  );
});

test('file names', () => {
  const fields: FilenameFields = {
    filename: 'DSC01234.ARW',
    versionName: null,
    versionIndex: 1,
    versionCount: 1,
    title: 'Harbour: night',
    capturedAt: '2024-05-01T12:34:56+02:00',
    camera: 'ILCE-7M4',
    lens: null,
    iso: 400,
    rating: 0,
  };
  assert.equal(exportFilename('{name}', fields, 'jpg'), 'DSC01234.jpg');
  assert.equal(exportFilename('{date}_{time} {name}', fields, 'tif'), '2024-05-01_123456 DSC01234.tif');
  // Empty tokens take their separator along.
  assert.equal(exportFilename('{name}-{version}', fields, 'jpg'), 'DSC01234.jpg');
  assert.equal(exportFilename('{name}-{lens}-{iso}', fields, 'jpg'), 'DSC01234-400.jpg');
  assert.equal(
    exportFilename('{name}-{version}', { ...fields, versionCount: 3, versionIndex: 2 }, 'jpg'),
    'DSC01234-v2.jpg',
  );
  assert.equal(exportFilename('{name}-{version}', { ...fields, versionName: 'B&W' }, 'jpg'), 'DSC01234-B&W.jpg');
  // Unsafe characters, unknown tokens, nothing left.
  assert.equal(exportFilename('{title}', fields, 'png'), 'Harbour_ night.png');
  assert.equal(exportFilename('{NAME} {nope}', fields, 'jpg'), 'DSC01234 {nope}.jpg');
  assert.equal(exportFilename('{lens}', fields, 'jpg'), 'DSC01234.jpg');
  assert.equal(exportFilename('../{rating}', fields, 'jpg'), 'DSC01234.jpg');
});
