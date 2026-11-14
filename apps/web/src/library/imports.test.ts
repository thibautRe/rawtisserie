import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleRun, summarize } from './imports.ts';

test("a run's outcome, by what happened to each file", () => {
  const run = sampleRun(
    [
      { status: 'imported' },
      { status: 'imported' },
      { status: 'skipped', kind: 'duplicate' },
      { status: 'skipped', kind: 'deleted' },
      { status: 'skipped', kind: 'unsupported', size: 0 },
      { status: 'skipped', kind: 'quota' },
      { status: 'failed' },
    ],
    true,
  );
  const s = summarize(run);
  assert.equal(s.total, 7);
  assert.equal(s.finished, 7);
  assert.deepEqual(
    [s.imported, s.duplicates, s.deleted, s.failed, s.refused].map((l) => l.length),
    [2, 1, 1, 1, 2],
  );
});

test('progress counts the bytes sent of the file uploading', () => {
  const run = sampleRun(
    [{ status: 'imported', size: 100 }, { status: 'uploading', size: 100, sent: 30 }, { size: 100 }],
    false,
  );
  const s = summarize(run);
  assert.equal(s.finished, 1);
  assert.equal(s.sentBytes, 130);
  assert.equal(s.totalBytes, 300);
});
