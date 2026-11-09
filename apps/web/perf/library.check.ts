/**
 * Going between the library and the developer, in a real browser on the production build,
 * with the API mocked (a library of six photos). Covers what depends on React's order of
 * rendering and effects across routes: the film roll lists what the library showed, and
 * going back restores the library's filters.
 *
 *   npm run test:library -w @rawtisserie/web
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type Browser, type Page, chromium } from 'playwright';
import { type PreviewServer, build, preview } from 'vite';
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

const detail = (p: Photo): PhotoDetail => ({
  ...p,
  exif: null,
  editParams: null,
  historyEnd: 0,
  revision: 0,
  history: [],
  versions: [{ id: p.id, name: null, index: 1, edited: false, thumbUrl: null }],
});

let server: PreviewServer;
let browser: Browser;
let page: Page;

before(async () => {
  await build({ root, logLevel: 'error' });
  server = await preview({ root, logLevel: 'warn', preview: { port: PORT, strictPort: true } });
  browser = await chromium.launch({ channel: 'chromium' });
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
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (body: unknown) => route.fulfill({ json: body });
    if (path === '/api/auth/me') return json({ user: { id: 'u', email: 'a@b.c', displayName: 'A' } });
    if (path === '/api/versions') {
      const q = url.searchParams.get('q') ?? '';
      const versions = PHOTOS.filter((p) => p.filename.includes(q));
      return json({ versions, total: versions.length });
    }
    if (path === '/api/versions/facets')
      return json({ cameras: [], lenses: [], tags: [], ratings: [], ranges: { total: PHOTOS.length } });
    const version = /^\/api\/versions\/(v\d+)$/.exec(path)?.[1];
    const p = PHOTOS.find((p) => p.id === version);
    if (p) return json(detail(p));
    if (path === '/api/presets') return json({ presets: [] });
    if (path === '/api/luts') return json({ luts: [] });
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
