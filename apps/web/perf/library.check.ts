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
/** Earlier imports, newest first, for the sidebar. */
const IMPORTS = [1, 2, 3, 4].map((n) => ({
  value: `00000000-0000-4000-8000-00000000000${n}`,
  count: n,
  importedAt: new Date(Date.UTC(2026, 0, 10 - n)).toISOString(),
  source: null,
}));
let knownHashes: Record<string, { status: string; filename: string }> = {};
/** File names `/api/photos/check` finds by name, size and date. */
let knownNames = new Set<string>();
let failUploads = new Set<string>();
/** Completing uploads waits for this, when set (an import to interrupt). */
let holdCompletes: Promise<void> | null = null;
/** Chunks (by their number, from 0) whose connection is cut, once. */
let cutChunks = new Set<number>();
let chunks = 0;
/** Uploads started (`/api/uploads`), by id: what's been received. */
let received = new Map<string, { name: string; size: number; offset: number }>();

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
/** A phone's viewport (roadmap 10.1), with a touch screen. */
const PHONE = { width: 390, height: 844 };

async function open(path: string, viewport = { width: 1600, height: 1000 }) {
  await page?.close();
  page = await browser.newPage({ viewport, hasTouch: viewport.width < 768 });
  page.on('pageerror', (e) => assert.fail(`page error: ${e.message}`));
  sent = [];
  patched = new Map();
  originals = {};
  recipes = {};
  flaky = new Set();
  knownHashes = {};
  knownNames = new Set();
  failUploads = new Set();
  received = new Map();
  cutChunks = new Set();
  chunks = 0;
  holdCompletes = null;
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (body: unknown) => route.fulfill({ json: body });
    const method = route.request().method();
    // Chunks are bytes: recorded by their upload below.
    if (method !== 'GET' && method !== 'PUT') sent.push({ path, body: route.request().postDataJSON() });
    if (path === '/api/photos/check') {
      const { hashes = [], files = [] } = route.request().postDataJSON() as {
        hashes?: string[];
        files?: { name: string }[];
      };
      return json({
        files: hashes.filter((h) => knownHashes[h]).map((h) => ({ sha256: h, ...knownHashes[h] })),
        named: files.flatMap((f, index) => (knownNames.has(f.name) ? [{ index, status: 'library' }] : [])),
      });
    }
    if (path === '/api/uploads' && method === 'POST') {
      const { name, size } = route.request().postDataJSON() as { name: string; size: number };
      const id = `up-${received.size}`;
      received.set(id, { name, size, offset: 0 });
      return json({ id, offset: 0 });
    }
    const upload = /^\/api\/uploads\/([^/]+)(\/complete)?$/.exec(path);
    if (upload) {
      const u = received.get(upload[1]!)!;
      if (method === 'PUT') {
        if (cutChunks.delete(chunks++)) return route.abort('connectionreset');
        u.offset += route.request().postDataBuffer()!.length;
        return json({ offset: u.offset });
      }
      if (method === 'GET') return json({ offset: u.offset, size: u.size });
      if (holdCompletes) return holdCompletes.then(() => route.abort()).catch(() => {});
      // Slow enough to see the files waiting.
      return new Promise<void>((resolve) =>
        setTimeout(() => {
          if (failUploads.delete(u.name)) resolve(route.fulfill({ status: 500, json: { error: 'disk full' } }));
          else resolve(json({ created: [{ ...PHOTOS[0], id: `new-${u.name}` }], skipped: [] }));
        }, 400),
      );
    }
    if (path === '/api/tags') return json(TAGS);
    if (path === '/api/tags/manage')
      return json({
        levels: [
          { value: 'People', photos: 3, trashed: 1 },
          { value: 'People|Alice', photos: 2, trashed: 1 },
          { value: 'People|Bob', photos: 1, trashed: 0 },
          { value: 'Family', photos: 1, trashed: 0 },
          { value: 'Family|Alice', photos: 1, trashed: 0 },
        ],
        own: [
          { tag: 'Places|Paris', shortcut: null },
          { tag: 'People|Bob', shortcut: [press('KeyO', 'o', 'ctrl+alt'), press('KeyN', 'n', 'ctrl+alt')] },
          { tag: 'beach', shortcut: [press('KeyB', 'b', 'ctrl+alt')] },
        ],
      });
    if (path === '/api/tags/rename' || path === '/api/tags/delete') return json({ versions: 3 });
    if (path === '/api/tags/shortcut') {
      sent.push({ path, body: route.request().postDataJSON() });
      return json(route.request().postDataJSON());
    }
    if (path === '/api/versions/bulk') {
      // Tags are kept, as the server would: the library reads them back.
      // A selection by filter (`filter`, `except`) has no ids: nothing to keep here.
      const { ids = [], patch } = route.request().postDataJSON() as {
        ids?: string[];
        patch: { addTags?: string[]; removeTags?: string[] };
      };
      for (const id of ids) {
        const tags = patched.get(id)?.tags ?? PHOTOS.find((p) => p.id === id)?.tags ?? [];
        const next = [...tags.filter((t) => !patch.removeTags?.includes(t)), ...(patch.addTags ?? [])];
        if (patch.addTags || patch.removeTags) patched.set(id, { ...patched.get(id), tags: [...new Set(next)] });
      }
      return json({ versions: [] });
    }
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
      const versions = PHOTOS.filter((p) => p.filename.includes(q)).map((p) => {
        const tags = patched.get(p.id)?.tags;
        return tags ? { ...p, tags } : p;
      });
      return json({ versions, total: versions.length });
    }
    if (path === '/api/versions/facets')
      return json({
        cameras: [],
        lenses: [],
        // Each level, counting the photos under it.
        tags: [
          { value: 'People', count: 3 },
          { value: 'People|Alice', count: 2 },
          { value: 'People|Bob', count: 1 },
          { value: 'beach', count: 4 },
        ],
        ratings: [],
        ranges: { total: PHOTOS.length },
        imports: IMPORTS,
      });
    const version = /^\/api\/versions\/(v\d+)$/.exec(path)?.[1];
    const p = PHOTOS.find((p) => p.id === version);
    if (p && method === 'PATCH') patched.set(p.id, { ...patched.get(p.id), ...route.request().postDataJSON() });
    if (p) return json({ ...detail(p), ...patched.get(p.id) });
    if (path === '/api/presets') return json({ presets: [] });
    if (path === '/api/luts') return json({ luts: [] });
    if (path === '/api/export-settings')
      return json({ settings: { format: 'jpeg', size: { mode: 'longEdge', longEdge: 256 } }, presets: [] });
    if (path === '/api/versions/delete') {
      const body = route.request().postDataJSON() as { ids?: string[]; filter?: string; except?: string[] };
      const q = new URLSearchParams(body.filter ?? '').get('q') ?? '';
      const matched = body.ids ?? MANY.filter((p) => p.filename.includes(q)).map((p) => p.id);
      return json({ trashed: matched.filter((id) => !body.except?.includes(id)) });
    }
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
  // The info panel shows the photo's once its details are in.
  await page.locator('#library-tag-input').waitFor();
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

test('tags are a tree: a parent picks what is under it, and `|` types a level', async () => {
  await open('/');
  await cards().first().click();
  // Folded below the top level.
  const tree = page.locator('[data-tag]');
  await page.locator('[data-tag="People"]').waitFor();
  assert.deepEqual(await tree.evaluateAll((els) => els.map((e) => e.getAttribute('data-tag'))), ['beach', 'People']);
  await page.getByRole('button', { name: 'Unfold People' }).click();
  assert.deepEqual(await tree.evaluateAll((els) => els.map((e) => e.getAttribute('data-tag'))), [
    'beach',
    'People',
    'People|Alice',
    'People|Bob',
  ]);
  // Searched: what's found and the way to it, unfolded.
  await page.getByRole('button', { name: 'Fold People' }).click();
  await page.getByLabel('Find a tag').fill('bob');
  assert.deepEqual(await tree.evaluateAll((els) => els.map((e) => e.getAttribute('data-tag'))), [
    'People',
    'People|Bob',
  ]);
  await page.getByLabel('Find a tag').press('Escape');
  assert.deepEqual(await tree.evaluateAll((els) => els.map((e) => e.getAttribute('data-tag'))), ['beach', 'People']);
  await page.locator('[data-tag="People"]').getByText('People').click();
  await page.waitForURL(/[?&]tag=People(&|$)/);
  // The list is read again for the filter: the photo picked once it's in.
  await page.waitForLoadState('networkidle');
  await cards().first().click();

  // The info panel shows the photo's once its details are in.
  await page.locator('#library-tag-input').waitFor();
  await page.keyboard.press('t');
  await page.waitForFunction(() => document.activeElement?.id === 'library-tag-input');
  await page.keyboard.type(' Family | Alice ');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await page.getByText('Family › Alice').waitFor();
  assert.deepEqual(sent.at(-1)?.body, { tags: ['Family|Alice'] });
});

test('the tag manager (Settings › Tags) edits, merges, creates and deletes, saying first what will happen', async () => {
  // Its old address leads there.
  await open('/tags');
  await page.waitForURL(/\/settings\/tags$/);
  const row = (tag: string) => page.locator(`[data-managed-tag="${tag}"]`);
  await row('People|Alice').waitFor();
  const act = async (tag: string, item: string) => {
    await row(tag)
      .getByRole('button', { name: /^Change/ })
      .click();
    await page.getByRole('menuitem', { name: item }).click();
  };
  const effect = page.locator('[data-tag-effect]');
  const editor = page.locator('[data-tag-editor]');
  const button = (name: string) => editor.getByRole('button', { name, exact: true });

  const path = page.locator('#tag-editor-path');
  await act('People|Alice', 'Edit…');
  // Its button says what it does, even before anything changed.
  assert.equal(await button('Save').isDisabled(), true);
  // Opened on its name, selected: typing renames it.
  await page.waitForFunction(() => document.activeElement?.id === 'tag-editor-path');
  assert.equal(
    await path.evaluate((i: HTMLInputElement) => i.value.slice(i.selectionStart!, i.selectionEnd!)),
    'Alice',
  );
  // Levels that don't exist yet are said so.
  await path.fill('People|Friends|Alice');
  assert.deepEqual(
    await page.locator('[data-tag-levels] [data-new]').evaluateAll((els) => els.map((e) => e.textContent)),
    ['Friendsnew', 'Alicenew'],
  );
  await path.fill('People|Alicia');
  assert.equal(
    await effect.innerText(),
    'People › Alice becomes People › Alicia on 2 photos (and 1 version in the trash).',
  );
  await button('Save').click();
  await page.getByText('Saved People › Alicia: 3 photos changed').waitFor();
  assert.deepEqual(sent.at(-1), { path: '/api/tags/rename', body: { from: 'People|Alice', to: 'People|Alicia' } });

  // Put inside a tag where one has its name: a merge, said so. The tags are suggested,
  // picking one goes on inside it.
  await act('People|Alice', 'Edit…');
  await path.fill('fam');
  await page.getByRole('option', { name: /^Family\s*\d+$/ }).click();
  assert.equal(await path.inputValue(), 'Family|');
  await page.keyboard.type('Alice');
  assert.match(await effect.innerText(), /Family › Alice exists already: they’ll be one tag\./);
  await button('Merge').click();
  await page.getByText('Saved Family › Alice: 3 photos changed').waitFor();
  assert.deepEqual(sent.at(-1)?.body, { from: 'People|Alice', to: 'Family|Alice' });

  // A new tag, inside another, with a shortcut: created, then given it.
  await act('Places', 'New child tag…');
  assert.equal(await path.inputValue(), 'Places|');
  await page.keyboard.type('Lyon');
  await editor.locator('[data-shortcut-recorder]').click();
  await page.keyboard.press('Control+Alt+KeyL');
  assert.match(await effect.innerText(), /Creates Places › Lyon\.[\s\S]*Ctrl\+Alt\+L will add or remove Places › Lyon/);
  await button('Create').click();
  await page.getByText('Created Places › Lyon').waitFor();
  assert.deepEqual(sent.slice(-2), [
    { path: '/api/tags', body: { tag: 'Places|Lyon' } },
    { path: '/api/tags/shortcut', body: { tag: 'Places|Lyon', shortcut: [press('KeyL', 'l', 'ctrl+alt')] } },
  ]);

  await act('People', 'Delete…');
  const dialog = page.getByRole('alertdialog');
  assert.match(
    await dialog.innerText(),
    /People will be removed from 3 photos \(and 1 version in the trash\), with the 2 tags under it\./,
  );
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(sent.at(-1), { path: '/api/tags/delete', body: { tag: 'People' } });
});

test('T focuses the tag input of several photos too', async () => {
  await open('/');
  await cards().first().waitFor();
  await page.keyboard.press('Control+a');
  // The info panel shows the photo's once its details are in.
  await page.locator('#library-tag-input').waitFor();
  await page.keyboard.press('t');
  await page.waitForFunction(() => document.activeElement?.id === 'library-tag-input');
  await page.keyboard.type('cit');
  await page.getByRole('option', { name: /city/ }).click();
  assert.deepEqual(sent.at(-1), {
    path: '/api/versions/bulk',
    // Ctrl+A selects by filter (roadmap 8.13): the whole library here.
    body: { filter: '', except: [], patch: { addTags: ['city'] } },
  });
  // Nothing matches: the form adds it as typed.
  await page.keyboard.type('dusk');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => (document.activeElement as HTMLInputElement).value === '');
  assert.deepEqual(sent.at(-1)?.body, { filter: '', except: [], patch: { addTags: ['dusk'] } });
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
  await page.locator('input[type=file]:not([webkitdirectory])').setInputFiles([
    { name: 'a.ARW', mimeType: 'application/octet-stream', buffer: raw(1) },
    { name: 'b.ARW', mimeType: 'application/octet-stream', buffer: raw(2) },
    { name: 'c.ARW', mimeType: 'application/octet-stream', buffer: raw(3) },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') },
  ]);
  // Reviewed first: nothing known by name, so all three RAW files are new.
  const review = page.locator('[data-import-review=ready]');
  await review.waitFor();
  assert.match(await review.innerText(), /3 RAW files[\s\S]*1 file not a RAW file or an image[\s\S]*3 new photos/);
  await review.getByRole('button', { name: 'Import 3 photos' }).click();
  // The library shows this import.
  await page.waitForURL(/[?&]import=[0-9a-f-]{36}/);
  const importId = new URL(page.url()).searchParams.get('import')!;
  // Shown in the sidebar's imports, picked.
  await page.locator(`[data-import="${importId}"][aria-pressed="true"]`).waitFor();
  // Leaving now asks first.
  assert.equal(await leavingAsks(), true);

  const done = page.locator('[data-import-state=done]');
  await done.waitFor({ timeout: 20_000 });
  const text = await done.innerText();
  assert.match(text, /1 photo imported/);
  assert.match(text, /1 file already in your library/);
  assert.match(text, /1 file failed/);
  assert.match(text, /1 file not imported \(not RAW files or images\)/);
  // Only the new files were sent, as part of this import; the duplicate wasn't.
  const uploads = () =>
    sent
      .filter((s) => s.path.endsWith('/complete'))
      .map((s) => ({
        file: received.get(s.path.split('/')[3]!)!.name,
        ...started().find((u) => u.name === received.get(s.path.split('/')[3]!)!.name)!,
      }));
  assert.deepEqual(
    uploads().map((u) => u.file),
    ['a.ARW', 'c.ARW'],
  );
  assert.ok(uploads().every((u) => u.import === importId));

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
  assert.equal(await leavingAsks(), false);

  // Back to the whole library: picking it again.
  await page.locator(`[data-import="${importId}"]`).click();
  await page.waitForURL((u) => !u.searchParams.has('import'));
});

/**
 * A JPEG with `xmp` where cameras and other applications put it: an APP1 segment with
 * Adobe's namespace, before the image (the import reads only the segments before it).
 */
function jpegWithXmp(xmp: string): Buffer {
  const payload = Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0'), Buffer.from(xmp)]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length + 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), length, payload, Buffer.from([0xff, 0xda, 0, 2])]);
}

test("a card: its folders walked through, what the library has, JPEGs next to their RAWs and what isn't a photo left out", async () => {
  await open('/');
  await cards().first().waitFor();
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const card = join(await mkdtemp(join(tmpdir(), 'card-')), 'DCIM');
  const dir = join(card, '100MSDCF');
  await mkdir(dir, { recursive: true });
  for (const [name, n] of [
    ['DSC00001.ARW', 1],
    ['DSC00002.ARW', 2],
    ['DSC00002.JPG', 3],
    ['._DSC00001.ARW', 4],
    ['C0001.MP4', 5],
  ] as const)
    await writeFile(join(dir, name), Buffer.alloc(1024, n));
  // Tagged in another application: the JPEG's XMP goes to its RAW.
  const xmp =
    '<x:xmpmeta xmp:Rating="3"><lr:hierarchicalSubject><rdf:Bag><rdf:li>People|Alice</rdf:li></rdf:Bag></lr:hierarchicalSubject></x:xmpmeta>';
  await writeFile(join(dir, 'DSC00001.JPG'), jpegWithXmp(xmp));
  knownNames = new Set(['DSC00002.ARW']);
  await page.locator('input[type=file][webkitdirectory]').setInputFiles(card);

  const review = page.locator('[data-import-review=ready]');
  await review.waitFor();
  const text = await review.innerText();
  assert.match(text, /Import from DCIM/);
  assert.match(text, /2 RAW files/);
  assert.match(text, /1 already in your library/);
  assert.match(text, /2 other files left out/);
  // The camera's JPEGs of the RAWs: left out unless asked for, their tags given to the RAWs.
  assert.match(text, /Also import the 2 JPEGs next to their RAW files/);
  assert.match(text, /1 new photo with tags, ratings or labels from their files/);
  await review.getByRole('button', { name: 'Import 1 photo' }).waitFor();
  await review.getByText('Also import the 2 JPEGs next to their RAW files').click();
  assert.match(await review.innerText(), /2 images/);
  await review.getByRole('button', { name: 'Import 3 photos' }).click();
  const done = page.locator('[data-import-state=done]');
  await done.waitFor({ timeout: 20_000 });
  assert.match(await done.innerText(), /1 file already in your library/);
  // Only the new ones were sent, with their dates.
  const sentFiles = started();
  assert.deepEqual(
    sentFiles.map((u) => u.name),
    ['DSC00001.ARW', 'DSC00001.JPG', 'DSC00002.JPG'],
  );
  const sentTags = sentFiles.map((u) => [(u as { tags?: string[] }).tags, (u as { rating?: number }).rating]);
  assert.deepEqual(sentTags, [
    [['People|Alice'], 3],
    [['People|Alice'], 3],
    [undefined, undefined],
  ]);
  assert.equal(typeof sentFiles[0]!.modified, 'number');
  await done.getByRole('button', { name: 'Close' }).click();
});

test('nothing new on a card: the review says so', async () => {
  await open('/');
  await cards().first().waitFor();
  knownNames = new Set(['a.ARW']);
  await page
    .locator('input[type=file]:not([webkitdirectory])')
    .setInputFiles([{ name: 'a.ARW', mimeType: 'application/octet-stream', buffer: Buffer.alloc(16) }]);
  const review = page.locator('[data-import-review=ready]');
  await review.waitFor();
  assert.match(await review.innerText(), /Nothing new to import/);
  await review.getByRole('button', { name: 'Close' }).first().click();
  await review.waitFor({ state: 'detached' });
  assert.equal(started().length, 0);
});

test('a large file goes in chunks, and a lost connection costs one chunk', async () => {
  await open('/');
  await cards().first().waitFor();
  cutChunks = new Set([1]);
  await page
    .locator('input[type=file]:not([webkitdirectory])')
    .setInputFiles([
      { name: 'big.ARW', mimeType: 'application/octet-stream', buffer: Buffer.alloc(20 * 1024 * 1024, 7) },
    ]);
  const review = page.locator('[data-import-review=ready]');
  await review.waitFor();
  await review.getByRole('button', { name: 'Import 1 photo' }).click();
  const done = page.locator('[data-import-state=done]');
  await done.waitFor({ timeout: 30_000 });
  assert.match(await done.innerText(), /Imported 1 photo/);
  // Three chunks of 8, 8 and 4 MiB, the second sent again; all of it received once.
  assert.equal(chunks, 4);
  assert.deepEqual(
    [...received.values()].map((u) => u.offset),
    [20 * 1024 * 1024],
  );
  assert.equal(started().length, 1);
});

test('an import interrupted by a reload is offered again, and resumes once its files are picked', async () => {
  await open('/');
  await cards().first().waitFor();
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'pick-'));
  const paths = [];
  for (const n of [1, 2, 3]) {
    paths.push(join(dir, `DSC0000${n}.ARW`));
    await writeFile(paths.at(-1)!, Buffer.alloc(1024, n));
  }
  // The first file is sent, then the tab goes before it's taken in.
  holdCompletes = new Promise(() => {});
  await page.locator('input[type=file]:not([webkitdirectory])').setInputFiles(paths);
  const review = page.locator('[data-import-review=ready]');
  await review.waitFor();
  await review.getByRole('button', { name: 'Import 3 photos' }).click();
  await waitFor(() => sent.some((s) => s.path.endsWith('/complete')));
  // Saved as it goes (half a second after a change).
  await page.waitForTimeout(800);
  holdCompletes = null;
  page.removeAllListeners('dialog');
  page.on('dialog', (d) => void d.accept());
  await page.reload();

  const interrupted = page.locator('[data-import-state=interrupted]');
  await interrupted.waitFor();
  const text = await interrupted.innerText();
  assert.match(text, /3 photos not sent yet/);
  // Files from an input aren't kept by any browser: picked again.
  assert.match(text, /Your current browser requires you to pick the files again/);
  const chooser = page.waitForEvent('filechooser');
  await interrupted.getByRole('button', { name: 'Pick the files again' }).click();
  await (await chooser).setFiles(paths);

  const done = page.locator('[data-import-state=done]');
  await done.waitFor({ timeout: 20_000 });
  assert.match(await done.innerText(), /Imported 3 photos/);
  // The first one wasn't sent again: its upload was completed where it stood.
  assert.equal(started().length, 3);
  assert.equal(page.url().includes('import='), true);
  // Done: not offered again.
  await page.waitForTimeout(200);
  await page.reload();
  await cards().first().waitFor();
  await page.waitForTimeout(500);
  assert.equal(await page.locator('[data-import-state=interrupted]').count(), 0);
});

/** Until `f` holds (polled), or fails after 10 s. */
async function waitFor(f: () => boolean) {
  for (let t = 0; !f(); t += 50) {
    if (t > 10_000) assert.fail('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A key press, as shortcuts store them. */
function press(code: string, key: string, mods = '') {
  return {
    code,
    key,
    ctrl: mods.includes('ctrl'),
    alt: mods.includes('alt'),
    shift: mods.includes('shift'),
    meta: false,
  };
}

test("a tag's shortcut is recorded in the tag manager, refused if the library has its keys", async () => {
  await open('/settings/tags');
  await page
    .locator('[data-managed-tag="Places|Paris"]')
    .getByRole('button', { name: /^Change/ })
    .click();
  await page.getByRole('menuitem', { name: 'Edit…' }).click();
  const recorder = page.locator('[data-shortcut-recorder]');
  await recorder.click();
  await page.keyboard.press('p');
  await page.getByText('P is one of the library’s keys').waitFor();
  // A pause: a new shortcut. Then a sequence of two, released in between.
  await page.waitForTimeout(1600);
  await page.keyboard.press('Control+Alt+KeyO');
  await page.keyboard.press('Control+Alt+KeyN');
  // People › Bob has it.
  await page.getByText('People › Bob has Ctrl+Alt+O, Ctrl+Alt+N').waitFor();
  await page.waitForTimeout(1600);
  await page.keyboard.press('Control+Alt+KeyO');
  await page.keyboard.press('Control+Alt+KeyP');
  assert.equal(await recorder.innerText(), 'Ctrl+Alt+O, Ctrl+Alt+P');
  await page.getByText(/Ctrl\+Alt\+O, Ctrl\+Alt\+P will add or remove Places › Paris/).waitFor();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Saved Places › Paris').waitFor();
  assert.deepEqual(sent.at(-1), {
    path: '/api/tags/shortcut',
    body: { tag: 'Places|Paris', shortcut: [press('KeyO', 'o', 'ctrl+alt'), press('KeyP', 'p', 'ctrl+alt')] },
  });
});

test('tag shortcuts toggle a tag on the selection; keys within a sequence do nothing else', async () => {
  await open('/');
  await cards().first().click();
  await page.locator('#library-tag-input').waitFor();
  const bulkSent = () => sent.filter((s) => s.path === '/api/versions/bulk').map((s) => s.body);
  await page.keyboard.press('Control+Alt+KeyO');
  await page.locator('[data-shortcut-pending]').getByText('Ctrl+Alt+O, …').waitFor();
  // Not the sequence's next key: it does nothing, not even Ctrl+Alt+B's tag or P's flag.
  await page.keyboard.press('Control+Alt+KeyB');
  await page.locator('[data-shortcut-pending]').waitFor({ state: 'detached' });
  await page.keyboard.press('Control+Alt+KeyO');
  await page.keyboard.press('p');
  await page.waitForTimeout(200);
  assert.deepEqual(bulkSent(), []);
  await page.keyboard.press('Control+Alt+KeyO');
  await page.keyboard.press('Control+Alt+KeyN');
  await page.getByText('Tagged 1 photo People › Bob').waitFor();
  await page.keyboard.press('Control+Alt+KeyB');
  await waitFor(() => bulkSent().length === 2);
  assert.deepEqual(bulkSent(), [
    { ids: [PHOTOS[0]!.id], patch: { addTags: ['People|Bob'] } },
    { ids: [PHOTOS[0]!.id], patch: { addTags: ['beach'] } },
  ]);

  // In the loupe, on the photo shown, which has it now: removed, then added again.
  await page.keyboard.press(' ');
  await page.getByText('Auto-advance', { exact: true }).waitFor();
  await page.keyboard.press('Control+Alt+KeyB');
  await page.getByText('Removed beach').waitFor();
  await waitFor(() => bulkSent().length === 3);
  await page.keyboard.press('Control+Alt+KeyB');
  await page.getByText(/^Tagged beach$/).waitFor();
  assert.deepEqual(bulkSent().slice(2), [
    { ids: [PHOTOS[0]!.id], patch: { removeTags: ['beach'] } },
    { ids: [PHOTOS[0]!.id], patch: { addTags: ['beach'] } },
  ]);
});

/** The uploads started, by what the app said of each file. */
const started = () =>
  sent
    .filter((s) => s.path === '/api/uploads')
    .map((s) => s.body as { name: string; import: string; modified: number });

/** Whether leaving the page now would ask first. */
const leavingAsks = () =>
  page.evaluate(() => {
    const e = new Event('beforeunload', { cancelable: true });
    dispatchEvent(e);
    return e.defaultPrevented;
  });

test('imports in the sidebar: one, a range with Shift, one more with Ctrl', async () => {
  await open('/');
  await cards().first().waitFor();
  if (!(await page.locator('[data-import]').first().isVisible()))
    await page.getByRole('button', { name: 'Recent imports' }).click();
  const ids = IMPORTS.map((i) => i.value);
  const row = (n: number) => page.locator(`[data-import="${ids[n]}"]`);
  const shown = () => new URL(page.url()).searchParams.getAll('import');
  const until = (ids: string[]) => page.waitForURL((u) => u.searchParams.getAll('import').join() === ids.join());
  await row(0).click();
  await until([ids[0]!]);
  await row(2).click({ modifiers: ['Shift'] });
  await until(ids.slice(0, 3));
  await row(1).click({ modifiers: ['ControlOrMeta'] });
  await until([ids[0]!, ids[2]!]);
  // From the last one clicked.
  await row(3).click({ modifiers: ['Shift'] });
  await until(ids.slice(1, 4));
  await page.waitForFunction(() => document.querySelectorAll('[data-import][aria-pressed="true"]').length === 3);
  // A click shows that one alone; again, the whole library.
  await row(2).click();
  await until([ids[2]!]);
  await row(2).click();
  await until([]);
  assert.deepEqual(shown(), []);
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

test('on a phone: filters in a drawer, a tap opens the loupe and a swipe moves on, a long press selects', async () => {
  await open('/', PHONE);
  await page.locator('[data-photo-id="v2"]').waitFor();
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.equal(await overflow(), 0, 'the library is wider than the phone');
  assert.equal(await page.getByText('Filters', { exact: true }).count(), 0, 'the filters are docked');

  // Sort and filters in a drawer.
  await page.getByRole('button', { name: 'Sort and filter' }).tap();
  const drawer = page.getByRole('dialog', { name: 'Sort and filter' });
  await drawer.getByRole('combobox', { name: 'Sort' }).waitFor();
  await drawer.getByRole('button', { name: 'Close' }).tap();
  await drawer.waitFor({ state: 'hidden' });

  // A tap opens the loupe (no developer on phones); a swipe goes to the next photo.
  await page.locator('[data-photo-id="v2"]').tap();
  await page.getByText('2 / 6').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Develop (D)' }).count(), 0);
  // Touch moves need Chromium's DevTools protocol.
  if (process.env.BROWSER !== 'firefox') {
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: [number, number][]) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
    await touch('touchStart', [[300, 400]]);
    for (let x = 300; x >= 100; x -= 25) await touch('touchMove', [[x, 405]]);
    await touch('touchEnd', []);
    await page.getByText('3 / 6').waitFor();
  }
  // A click: Chrome takes a tap right after a swipe's fling as stopping the fling (no click).
  await page.getByRole('button', { name: 'Close (Esc)' }).click();
  await page.getByRole('button', { name: 'Close (Esc)' }).waitFor({ state: 'detached' });

  // A long press selects, then taps add to the selection rather than opening the loupe.
  const card = (await page.locator('[data-photo-id="v1"]').boundingBox())!;
  await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await page.getByText('1 selected').waitFor();
  await page.locator('[data-photo-id="v3"]').tap();
  await page.getByText('2 selected').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Close (Esc)' }).count(), 0, 'a tap opened the loupe');

  // Their details in a sheet: rate both; Escape closes it and keeps the selection.
  await page.getByRole('button', { name: 'Details' }).tap();
  const sheet = page.getByRole('dialog', { name: 'Details' });
  await sheet.getByText('2 photos selected').waitFor();
  await sheet.getByRole('radio', { name: '3 stars (3)' }).tap();
  await page.waitForTimeout(300);
  const rated = sent.find((r) => r.path === '/api/versions/bulk')?.body as { ids: string[]; patch: unknown };
  assert.deepEqual([...rated.ids].sort(), ['v1', 'v3']);
  assert.deepEqual(rated.patch, { rating: 3 });
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'hidden' });
  await page.getByText('2 selected').waitFor();
  await page.getByRole('button', { name: 'Clear the selection' }).tap();
  await page.getByText('6 photos').waitFor();

  // The settings fit too.
  await open('/settings/tags', PHONE);
  await page.getByRole('heading', { name: 'Tags', exact: true }).waitFor();
  assert.equal(await overflow(), 0, 'the tag manager is wider than the phone');
});

test('Ctrl+A selects every photo the filters match, loaded or not; actions on it ask first and go by filter', async () => {
  await open('/?q=many');
  await page.locator('[data-photo-id]').first().waitFor();
  await page.keyboard.press('Control+a');
  await page.getByText('All 600 photos selected').waitFor();

  // One unticked by hand: the server is told which.
  const first = await page.locator('[data-photo-id]').first().getAttribute('data-photo-id');
  await page.locator(`[data-photo-id="${first}"]`).click({ modifiers: ['ControlOrMeta'] });
  await page.getByText('599 of 600 photos selected').waitFor();
  assert.equal(await page.locator(`[data-photo-id="${first}"][data-selected]`).count(), 0);

  // A rating asks first, with the number, and is sent as the filter.
  await page.keyboard.press('3');
  const dialog = page.getByRole('alertdialog');
  await dialog.getByText('Rate 599 photos 3 stars?').waitFor();
  assert.equal(sent.filter((r) => r.path === '/api/versions/bulk').length, 0, 'sent before confirming');
  await dialog.getByRole('button', { name: 'Rate' }).click();
  await page.waitForTimeout(300);
  assert.deepEqual(sent.find((r) => r.path === '/api/versions/bulk')?.body, {
    filter: 'q=many',
    except: [first],
    patch: { rating: 3 },
  });

  // Cancelling sends nothing.
  await page.keyboard.press('x');
  await dialog.getByText('Reject 599 photos?').waitFor();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(sent.filter((r) => r.path === '/api/versions/bulk').length, 1);
  await page.getByText('599 of 600 photos selected').waitFor();

  // A plain click goes back to selecting by id; another filter drops a selection by filter.
  await page.locator('[data-photo-id]').nth(2).click();
  await page.getByText('1 of 600 photos').waitFor();
  await page.keyboard.press('Control+a');
  await page.getByText('All 600 photos selected').waitFor();
  await page.getByPlaceholder('Search filename').fill('many-5');
  await page.getByText('111 photos', { exact: true }).waitFor();

  // The trash too, with an Undo for all of them.
  await page.getByPlaceholder('Search filename').fill('many');
  await page.getByText('600 photos', { exact: true }).waitFor();
  // Not the search's text: the grid's.
  await page.getByPlaceholder('Search filename').blur();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await dialog.getByText('Move 600 photos to the trash?').waitFor();
  await dialog.getByRole('button', { name: 'Move to trash' }).click();
  await page.getByText('Moved 600 photos to the trash').waitFor();
  assert.deepEqual(sent.find((r) => r.path === '/api/versions/delete')?.body, { filter: 'q=many', except: [] });
});
