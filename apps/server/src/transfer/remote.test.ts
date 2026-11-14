import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.DATABASE_URL ??= 'postgres://unused';
const { isPrivate, normalizeUrl } = await import('./remote.ts');

test('addresses only the server can reach are private', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0'])
    assert.ok(isPrivate(a), a);
  for (const a of ['::1', 'fd12::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1']) assert.ok(isPrivate(a), a);
  for (const a of ['51.178.16.218', '8.8.8.8', '2001:41d0:305:2100::500', '::ffff:8.8.8.8'])
    assert.ok(!isPrivate(a), a);
});

test('an instance is its origin, over HTTPS', () => {
  assert.equal(normalizeUrl('photos.example.com'), 'https://photos.example.com');
  assert.equal(normalizeUrl(' https://photos.example.com/library?x=1 '), 'https://photos.example.com');
  assert.throws(() => normalizeUrl('http://photos.example.com'), /HTTPS/);
  assert.throws(() => normalizeUrl('https://'), /isn’t an address/);
});
