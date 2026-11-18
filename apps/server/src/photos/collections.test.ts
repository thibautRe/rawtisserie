import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CollectionName, CollectionPath } from './collections.ts';

test('a collection name is one line, trimmed, and refuses `|`; paths from files replace it', () => {
  assert.equal(CollectionName.parse('  Wedding \n day '), 'Wedding day');
  assert.equal(CollectionName.safeParse('A|B').success, false);
  assert.equal(CollectionName.safeParse('   ').success, false);
  assert.deepEqual(CollectionPath.parse(['2026', 'Trip | Japan']), ['2026', 'Trip - Japan']);
});
