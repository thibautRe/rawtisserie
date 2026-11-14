import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.DATABASE_URL ??= 'postgres://unused';
const { SentVersion } = await import('./protocol.ts');

const version = (patch: Record<string, unknown>) => ({
  origin: { instance: crypto.randomUUID(), id: crypto.randomUUID(), label: 'localhost:5173' },
  importId: crypto.randomUUID(),
  sha256: 'a'.repeat(64),
  filename: 'A7R00087.ARW',
  patch: { rating: 3, tags: ['beach'], ...patch },
  exif: null,
  history: { end: 0, entries: [] },
});

test("a photo's values are taken as its file has them", () => {
  // A manual lens: no aperture or focal length (0), which an edit couldn't set.
  const manual = { iso: 100, exposureTime: 0.003125, fNumber: 0, focalLength: 0, artist: 'x'.repeat(300) };
  assert.ok(SentVersion.safeParse(version(manual)).success);
  assert.ok(!SentVersion.safeParse(version({ fNumber: -1 })).success);
  assert.ok(!SentVersion.safeParse(version({ rating: 9 })).success);
});
