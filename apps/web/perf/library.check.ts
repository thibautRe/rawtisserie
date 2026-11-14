/**
 * Going between the library and the developer, in a real browser on the production build,
 * with the API mocked (a library of six photos). Covers what depends on React's order of
 * rendering and effects across routes: the film roll lists what the library showed, and
 * going back restores the library's filters. Also completing tags in the info panel, whose
 * keys are shared between Chakra's TagsInput and our suggestions.
 *
 *   npm run test:library -w @rawtisserie/web
 *   BROWSER=firefox npm run test:library -w @rawtisserie/web   (after `npx playwright install firefox`)
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type Browser, type Page, chromium, firefox } from 'playwright';
import { type PreviewServer, build, preview } from 'vite';
import { existsSync } from 'node:fs';
import { defaultEditParams } from '@rawtisserie/pipeline';
import type { Photo, PhotoDetail } from '../src/api/types.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const PORT = 4182;
const URL_ = `http://localhost:${PORT}`;

const photo = (i: number): Photo => ({
  id: `v${i}`,
  photoId: `p${i}`,
  versionName: null,
  versionIndex: 1,
  versionCount: 1,
  filename: `${i % 2 ? 'beach' : 'city'}-${i}.ARW`,
  fileSize: 1,
  cameraMake: null,
  cameraModel: null,
  lens: null,
  iso: null,
  exposureTime: null,
  fNumber: null,
  focalLength: null,
  exposureBias: null,
  capturedAt: null,
  width: 6000,
  height: 4000,
  gpsLatitude: null,
  gpsLongitude: null,
  artist: null,
  copyright: null,
  title: null,
  description: null,
  rating: 0,
  flag: null,
  colorLabel: null,
  tags: [],
  edited: false,
  renderStatus: 'ready',
  renderError: null,
  thumbUrl: null,
  previewUrl: null,
  originalUrl: `/api/photos/p${i}/original`,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});
const PHOTOS = [1, 2, 3, 4, 5, 6].map(photo);
const MANY = Array.from({ length: 600 }, (_, i) => ({ ...photo(100 + i), filename: `many-${i}.ARW` }));

const detail = (p: Photo): PhotoDetail => ({
  ...p,
  exif: null,
  editParams: null,
  historyEnd: 0,
  revision: 0,
  history: [],
  versions: [{ id: p.id, name: null, index: 1, edited: false, thumbUrl: null }],
});

const TAGS = [
  { value: 'beach', count: 4 },
  { value: 'seascape', count: 3 },
  { value: 'seagull', count: 1 },
  { value: 'city', count: 2 },
];
/** The bodies of the edits sent, in order. */
let sent: { path: string; body: unknown }[] = [];
/** Each version's edits so far. */
let patched = new Map<string, Partial<PhotoDetail>>();
/** Files served as originals, by photo id (the others aren't found). */
let originals: Record<string, string> = {};
/** Versions whose current recipe is known (`/api/versions/recipes`); the others aren't read yet. */
let recipes: Record<string, unknown> = {};
/** Originals whose next download fails with a server error. */
let flaky = new Set<string>();
/** Imports: what `/api/photos/check` knows, and the files whose upload fails next. */
let knownHashes: Record<string, { status: string; filename: string }> = {};
let failUploads = new Set<string>();

let server: PreviewServer;
let browser: Browser;
let page: Page;

before(async () => {
  await build({ root, logLevel: 'error' });
  server = await preview({ root, logLevel: 'warn', preview: { port: PORT, strictPort: true } });
  browser = await (process.env.BROWSER === 'firefox' ? firefox.launch() : chromium.launch({ channel: 'chromium' }));
});

after(async () => {
  await browser?.close();
  await server?.close();
});

/** A fresh tab (its own session storage) on the mocked API. */
async function open(path: string) {
  await page?.close();
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('pageerror', (e) => assert.fail(`page error: ${e.message}`));
  sent = [];
  patched = new Map();
  originals = {};
  recipes = {};
  flaky = new Set();
  knownHashes = {};
  failUploads = new Set();
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (body: unknown) => route.fulfill({ json: body });
    const method = route.request().method();
    if (method !== 'GET' && path !== '/api/photos') sent.push({ path, body: route.request().postDataJSON() });
    if (path === '/api/photos/check') {
      const { hashes } = route.request().postDataJSON() as { hashes: string[] };
      return json({ files: hashes.filter((h) => knownHashes[h]).map((h) => ({ sha256: h, ...knownHashes[h] })) });
    }
    if (path === '/api/photos' && method === 'POST') {
      const name = /filename="([^"]+)"/.exec(route.request().postDataBuffer()!.toString('latin1'))?.[1] ?? '';
      sent.push({ path, body: { file: name, query: url.search } });
      // Slow enough to see the files waiting.
      return new Promise<void>((resolve) =>
        setTimeout(() => {
          if (failUploads.delete(name)) resolve(route.fulfill({ status: 500, json: { error: 'disk full' } }));
          else resolve(json({ created: [{ ...PHOTOS[0], id: `new-${name}` }], skipped: [] }));
        }, 400),
      );
    }
    if (path === '/api/tags') return json(TAGS);
    if (path === '/api/versions/bulk') return json({ versions: [] });
    if (path === '/api/auth/me') return json({ user: { id: 'u', email: 'a@b.c', displayName: 'A', isAdmin: false } });
    if (path === '/api/account/storage') return json({ used: 0, quota: null });
    if (path === '/api/versions') {
      const q = url.searchParams.get('q') ?? '';
      // `many…`: a library of hundreds, in pages.
      if (q.startsWith('many')) {
        const all = MANY.filter((p) => p.filename.includes(q));
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const limit = Number(url.searchParams.get('limit') ?? 200);
        return json({ versions: all.slice(offset, offset + limit), total: all.length });
      }
      const versions = PHOTOS.filter((p) => p.filename.includes(q));
      return json({ versions, total: versions.length });
    }
    if (path === '/api/versions/facets')
      return json({ cameras: [], lenses: [], tags: [], ratings: [], ranges: { total: PHOTOS.length } });
    const version = /^\/api\/versions\/(v\d+)$/.exec(path)?.[1];
    const p = PHOTOS.find((p) => p.id === version);
    if (p && method === 'PATCH') patched.set(p.id, { ...patched.get(p.id), ...route.request().postDataJSON() });
    if (p) return json({ ...detail(p), ...patched.get(p.id) });
    if (path === '/api/presets') return json({ presets: [] });
    if (path === '/api/luts') return json({ luts: [] });
    if (path === '/api/export-settings')
      return json({ settings: { format: 'jpeg', size: { mode: 'longEdge', longEdge: 256 } }, presets: [] });
    if (path === '/api/versions/recipes') {
      const { ids } = route.request().postDataJSON() as { ids: string[] };
      return json({
        versions: ids
          .filter((id) => id in recipes)
          .map((id) => ({ id, historyEnd: 1, revision: 1, recipe: recipes[id] })),
        notReady: ids.filter((id) => !(id in recipes)),
      });
    }
    const original = /^\/api\/photos\/(p\d+)\/original$/.exec(path)?.[1];
    if (original && flaky.delete(original)) return route.fulfill({ status: 503, json: { error: 'busy' } });
    if (original && originals[original]) return route.fulfill({ path: originals[original] });
    // Originals and the rest: the developer shows an error, the film roll stays.
    return route.fulfill({ status: 404, json: { error: 'not found' } });
  });
  await page.goto(`${URL_}${path}`);
}

const cards = () => page.locator('[data-photo-id]');
const roll = () => page.locator('[data-roll-id]');

async function rollIds() {
  await roll().first().waitFor();
  return roll().evaluateAll((els) => els.map((e) => e.getAttribute('data-roll-id')));
}

test('the film roll lists the photos of a filter set just before opening one', async () => {
  await open('/');
  await cards().first().waitFor();
  assert.equal(await cards().count(), 6);
  await page.getByPlaceholder('Search filename').fill('beach');
  await page.waitForFunction(() => document.querySelectorAll('[data-photo-id]').length === 3);
  await cards().first().dblclick();
  await page.waitForURL(/\/versions\/v\d\/develop/);
  assert.deepEqual(await rollIds(), ['v1', 'v3', 'v5']);
});

test('going back restores the filter, and the roll follows a new one', async () => {
  await open('/?q=city');
  await cards().first().waitFor();
  await cards().nth(1).dblclick();
  await page.waitForURL(/\/versions\/v4\/develop/);
  assert.deepEqual(await rollIds(), ['v2', 'v4', 'v6']);
  // The original isn't served: the developer shows its error, with a link back.
  await page.getByRole('link', { name: 'Back to library' }).click();
  await page.waitForURL((u) => u.pathname === '/');
  assert.equal(new URL(page.url()).searchParams.get('q'), 'city');
  // The search box shows the restored filter; clear it and open another photo.
  await page.getByPlaceholder('Search filename').fill('');
  await page.waitForFunction(() => document.querySelectorAll('[data-photo-id]').length === 6);
  await cards().first().dblclick();
  await page.waitForURL(/\/develop/);
  assert.equal((await rollIds()).length, 6);
});

test("T focuses the tag input, which completes from the library's tags", async () => {
  await open('/');
  await cards().first().click();
  await page.keyboard.press('t');
  const input = page.locator('#library-tag-input');
  await page.waitForFunction(() => document.activeElement?.id === 'library-tag-input');
  // A typo still finds it, and Enter picks it.
  await page.keyboard.type('baech');
  await page.getByRole('option', { name: /beach/ }).waitFor();
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => document.querySelectorAll('[data-scope="tags-input"][data-part="item"]').length === 1,
  );
  assert.deepEqual(sent.at(-1), { path: '/api/versions/v1', body: { tags: ['beach'] } });
  assert.equal(await input.inputValue(), '');
  // Arrows move through the suggestions; Escape closes them, Enter then adds what's typed.
  await page.keyboard.type('sea');
  await page.getByRole('listbox').waitFor();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => document.querySelectorAll('[data-scope="tags-input"][data-part="item"]').length === 2,
  );
  assert.deepEqual(sent.at(-1)?.body, { tags: ['beach', 'seagull'] });
  await page.keyboard.type('sea');
  await page.getByRole('listbox').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('listbox').count(), 0);
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => document.querySelectorAll('[data-scope="tags-input"][data-part="item"]').length === 3,
  );
  assert.deepEqual(sent.at(-1)?.body, { tags: ['beach', 'seagull', 'sea'] });
});

test('T focuses the tag input of several photos too', async () => {
  await open('/');
  await cards().first().waitFor();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('t');
  await page.waitForFunction(() => document.activeElement?.id === 'library-tag-input');
  await page.keyboard.type('cit');
  await page.getByRole('option', { name: /city/ }).click();
  assert.deepEqual(sent.at(-1), {
    path: '/api/versions/bulk',
    body: { ids: PHOTOS.map((p) => p.id), patch: { addTags: ['city'] } },
  });
  // Nothing matches: the form adds it as typed.
  await page.keyboard.type('dusk');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => (document.activeElement as HTMLInputElement).value === '');
  assert.deepEqual(sent.at(-1)?.body, { ids: PHOTOS.map((p) => p.id), patch: { addTags: ['dusk'] } });
});

/** A golden-test RAW (`scripts/fetch-golden-raws.sh`). */
const RAW = fileURLToPath(new URL('../../../crates/pipeline/tests/golden/raws/sony-ilce-7m3.arw', import.meta.url));

/** The names of the JPEG files in a ZIP, from its central directory. */
function zipNames(zip: Buffer): string[] {
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  const names = [];
  let at = zip.readUInt32LE(end + 16);
  for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
    const length = zip.readUInt16LE(at + 28);
    const name = zip.toString('utf8', at + 46, at + 46 + length);
    // Each file is stored as is: a JPEG starts with its SOI marker.
    const local = zip.readUInt32LE(at + 42);
    const data = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    assert.equal(zip.readUInt16BE(data), 0xffd8, `${name} is a JPEG`);
    assert.ok(zip.readUInt32LE(at + 24) > 1000, `${name} has an image`);
    names.push(name);
    at += 46 + length + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return names;
}

test(
  'Ctrl+E exports the selection as one ZIP, and the photos that failed again into another',
  { skip: !existsSync(RAW) },
  async () => {
    await open('/?q=beach');
    await page.waitForFunction(() => document.querySelectorAll('[data-photo-id]').length === 3);
    // v1 has an edited recipe; v3 and v5 are new uploads (the recipe for their file), whose
    // originals are missing at first.
    originals = { p1: RAW };
    recipes = { v1: defaultEditParams };
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+e');
    await page.getByRole('heading', { name: 'Export 3 photos' }).waitFor();
    const download = page.waitForEvent('download', { timeout: 120_000 });
    await page.getByRole('button', { name: 'Export JPEG' }).click();
    await page.getByText(/Exporting: [0-3] of 3 done/).waitFor();
    const file = await download;
    assert.match(file.suggestedFilename(), /^rawtisserie-\d{4}-\d\d-\d\d-\d{6}\.zip$/);
    const { readFile, stat } = await import('node:fs/promises');
    // In the order they finished: lanes export several at once.
    assert.deepEqual(zipNames(await readFile(await file.path())), ['beach-1.jpg']);
    // It was written to disk (OPFS) as it was made, not kept in memory.
    const spooled = await page.evaluate(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('exports');
      const sizes = [];
      for await (const [, h] of (
        dir as unknown as { entries(): AsyncIterable<[string, FileSystemFileHandle]> }
      ).entries())
        sizes.push((await h.getFile()).size);
      return sizes;
    });
    assert.deepEqual(spooled, [(await stat(await file.path())).size]);
    await page.getByText('Exported 1 of 3 photos').waitFor();
    await page.getByText('beach-3.ARW: Could not download the original (Not Found)').waitFor();
    await page.getByText('beach-5.ARW: Could not download the original (Not Found)').waitFor();
    // Once their originals can be had, Retry exports them into an archive of their own.
    originals = { p1: RAW, p3: RAW, p5: RAW };
    const retried = page.waitForEvent('download', { timeout: 120_000 });
    await page.getByRole('button', { name: 'Retry 2' }).click();
    const again = await retried;
    assert.match(again.suggestedFilename(), /^rawtisserie-\d{4}-\d\d-\d\d-\d{6}-retry\.zip$/);
    assert.deepEqual(zipNames(await readFile(await again.path())).sort(), ['beach-3.jpg', 'beach-5.jpg']);
    await page.getByText('Exported 2 photos').waitFor();
    await page.getByText('Exported 1 of 3 photos').waitFor({ state: 'detached' });
  },
);

test(
  'one photo is exported as its file, from the info panel, through a server error',
  { skip: !existsSync(RAW) },
  async () => {
    await open('/?q=beach');
    await cards().first().waitFor();
    originals = { p1: RAW };
    recipes = { v1: defaultEditParams };
    // A server error is tried again.
    flaky = new Set(['p1']);
    await cards().first().click();
    await page.getByRole('button', { name: 'Actions' }).click();
    await page.getByRole('menuitem', { name: /^Export/ }).click();
    await page.getByRole('heading', { name: 'Export', exact: true }).waitFor();
    const download = page.waitForEvent('download', { timeout: 120_000 });
    await page.getByRole('button', { name: 'Export JPEG' }).click();
    const file = await download;
    assert.equal(file.suggestedFilename(), 'beach-1.jpg');
    const { readFile } = await import('node:fs/promises');
    assert.equal((await readFile(await file.path())).readUInt16BE(0), 0xffd8);
    await page.getByText('Exported beach-1.jpg').waitFor();
  },
);

test(
  'a large export is saved in parts, each deleting the one before from storage',
  { skip: !existsSync(RAW) },
  async () => {
    await open('/?q=beach');
    await page.waitForFunction(() => document.querySelectorAll('[data-photo-id]').length === 3);
    originals = { p1: RAW, p3: RAW, p5: RAW };
    // Parts of a byte: each photo starts a new one.
    await page.evaluate(() => localStorage.setItem('debug.exportPartSize', '1'));
    const downloads: import('playwright').Download[] = [];
    page.on('download', (d) => downloads.push(d));
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+e');
    await page.getByRole('button', { name: 'Export JPEG' }).click();
    await page.getByText('Exported 3 photos in 3 ZIP files').waitFor({ timeout: 120_000 });
    const { readFile } = await import('node:fs/promises');
    const parts = await Promise.all(
      downloads.map(async (d) => [
        d.suggestedFilename().replace(/^.*-(part\d)\.zip$/, '$1'),
        zipNames(await readFile(await d.path())),
      ]),
    );
    assert.deepEqual(parts.map((p) => p[0]).sort(), ['part1', 'part2', 'part3']);
    assert.deepEqual(parts.flatMap((p) => p[1]).sort(), ['beach-1.jpg', 'beach-3.jpg', 'beach-5.jpg']);
    // Each part deleted the one before: only the last is left.
    const left = await page.evaluate(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('exports');
      let n = 0;
      for await (const _ of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) n++;
      return n;
    });
    assert.equal(left, 1);
  },
);

test(
  'an original opened before is read from the browser, not downloaded again',
  { skip: !existsSync(RAW) },
  async () => {
    await open('/?q=beach');
    await cards().first().waitFor();
    originals = { p1: RAW };
    let downloads = 0;
    const wasm: string[] = [];
    page.on('request', (r) => {
      if (r.url().endsWith('/api/photos/p1/original')) downloads++;
      if (r.url().endsWith('.wasm')) wasm.push(r.url());
    });
    // The developer's canvas shows once the photo is decoded.
    const opened = () => page.locator('canvas').first().waitFor({ timeout: 120_000 });
    await page.goto(`${URL_}/versions/v1/develop`);
    await opened();
    assert.equal(downloads, 1);
    // The pipeline worker fetches the wasm once, for itself and its pool.
    assert.equal(wasm.length, 1);
    // Stored once downloaded, in the background.
    await page.waitForFunction(async () => {
      for (const name of await caches.keys())
        if (await (await caches.open(name)).match('/api/photos/p1/original')) return true;
      return false;
    });
    await page.reload();
    await opened();
    assert.equal(downloads, 1);
  },
);

test('an import shows its files waiting, then what happened to each, and retries what failed', async () => {
  await open('/');
  await cards().first().waitFor();
  const raw = (n: number) => Buffer.alloc(64 * 1024, n);
  const { createHash } = await import('node:crypto');
  knownHashes = { [createHash('sha256').update(raw(2)).digest('hex')]: { status: 'library', filename: 'old.ARW' } };
  failUploads = new Set(['c.ARW']);
  await page.locator('input[type=file]').setInputFiles([
    { name: 'a.ARW', mimeType: 'application/octet-stream', buffer: raw(1) },
    { name: 'b.ARW', mimeType: 'application/octet-stream', buffer: raw(2) },
    { name: 'c.ARW', mimeType: 'application/octet-stream', buffer: raw(3) },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') },
  ]);
  // The library shows this import, its files first while they're waiting (not the text file).
  await page.waitForURL(/[?&]import=[0-9a-f-]{36}/);
  const importId = new URL(page.url()).searchParams.get('import')!;
  await page.locator('[data-pending]').first().waitFor();
  assert.ok((await page.locator('[data-pending]').count()) <= 3);
  await page.getByText(/^Imported .* · /).waitFor();

  const done = page.locator('[data-import-state=done]');
  await done.waitFor({ timeout: 20_000 });
  assert.equal(await page.locator('[data-pending]').count(), 0);
  const text = await done.innerText();
  assert.match(text, /1 photo imported/);
  assert.match(text, /1 file already in your library/);
  assert.match(text, /1 file failed/);
  assert.match(text, /1 file not imported \(not RAW files\)/);
  // Only the new files were sent, as part of this import; the duplicate wasn't.
  const uploads = () =>
    sent.filter((s) => s.path === '/api/photos').map((s) => s.body as { file: string; query: string });
  assert.deepEqual(
    uploads().map((u) => u.file),
    ['a.ARW', 'c.ARW'],
  );
  assert.ok(uploads().every((u) => u.query.includes(`import=${importId}`)));

  // It stays until closed; Retry sends the failed one again.
  await page.waitForTimeout(600);
  await done.getByRole('button', { name: 'Retry' }).click();
  await page.waitForFunction(() =>
    /2 photos imported/.test(document.querySelector('[data-import-state=done]')?.textContent ?? ''),
  );
  assert.deepEqual(
    uploads().map((u) => u.file),
    ['a.ARW', 'c.ARW', 'c.ARW'],
  );
  await done.getByRole('button', { name: 'Close' }).click();
  await done.waitFor({ state: 'detached' });

  // Back to the whole library.
  await page.getByRole('button', { name: 'Show the whole library' }).click();
  await page.waitForURL((u) => !u.searchParams.has('import'));
});

/** The library grid's scroller, and how far down it is. */
const gridScroll = () =>
  page.evaluate(() => {
    let el = document.querySelector('[data-photo-id]')?.parentElement ?? null;
    while (el && getComputedStyle(el).overflowY !== 'auto') el = el.parentElement;
    return el ? { top: el.scrollTop, height: el.clientHeight } : null;
  });

/** Photos actually on screen in the grid (not just rendered somewhere above or below). */
const cardsOnScreen = () =>
  page.evaluate(() => {
    let el = document.querySelector('[data-photo-id]')?.parentElement ?? null;
    while (el && getComputedStyle(el).overflowY !== 'auto') el = el.parentElement;
    const box = el?.getBoundingClientRect();
    if (!box) return 0;
    return [...document.querySelectorAll('[data-photo-id]')].filter((c) => {
      const r = c.getBoundingClientRect();
      return r.bottom > box.top && r.top < box.bottom;
    }).length;
  });

test('back from the developer, the library is where it was, and a filter then shows its photos', async () => {
  await open('/?q=many');
  await cards().first().waitFor();
  await page.evaluate(() => {
    let el = document.querySelector('[data-photo-id]')?.parentElement ?? null;
    while (el && getComputedStyle(el).overflowY !== 'auto') el = el.parentElement;
    el!.scrollTop = 3000;
  });
  await page.waitForTimeout(1000);
  assert.ok((await cardsOnScreen()) > 0);
  const before = (await gridScroll())!;
  assert.ok(before.top > 2500);
  // Open one that's on screen; its original isn't served: back from the error.
  const onScreen = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-photo-id]')];
    const mid = window.innerHeight / 2;
    return cards
      .find((c) => {
        const r = c.getBoundingClientRect();
        return r.top < mid && r.bottom > mid;
      })!
      .getAttribute('data-photo-id');
  });
  await page.locator(`[data-photo-id="${onScreen}"]`).dblclick();
  await page.waitForURL(/\/develop/);
  await page.getByRole('link', { name: 'Back to library' }).click();
  await page.waitForURL((u) => u.pathname === '/');
  await page.waitForTimeout(800);
  const after = (await gridScroll())!;
  assert.ok(Math.abs(after.top - before.top) < 300, `scrolled to ${after.top}, was ${before.top}`);
  assert.ok((await cardsOnScreen()) > 0, 'no photo on screen');

  // A filter with a few photos, without scrolling first: they're on screen.
  await page.getByPlaceholder('Search filename').fill('many-599');
  await page.waitForFunction(() => document.querySelectorAll('[data-photo-id]').length === 1);
  await page.waitForTimeout(300);
  assert.equal(await cardsOnScreen(), 1);
});
