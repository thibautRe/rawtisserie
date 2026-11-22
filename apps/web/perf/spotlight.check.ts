/**
 * The spotlight (roadmap 2.6, a prototype) in a real browser, on the production build of
 * the public `/develop` page: Ctrl+Space, a few letters, and the mouse drives a slider.
 *
 *   npm run test:spotlight -w @rawtisserie/web
 *
 * Tests share one page, in order. PERF_RAW picks the file (default: the golden Sony ARW);
 * SPOTLIGHT_SHOTS=dir saves screenshots.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type Browser, type Page, chromium } from 'playwright';
import { type PreviewServer, build, preview } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const raw =
  process.env.PERF_RAW ??
  fileURLToPath(new URL('../../../crates/pipeline/tests/golden/raws/sony-ilce-7m3.arw', import.meta.url));
const shots = process.env.SPOTLIGHT_SHOTS;
const PORT = 4184;

let server: PreviewServer;
let browser: Browser;
let page: Page;

before(async () => {
  assert.ok(existsSync(raw), `No RAW file at ${raw}: run ./scripts/fetch-golden-raws.sh or set PERF_RAW.`);
  if (shots) mkdirSync(shots, { recursive: true });
  await build({ root, logLevel: 'error' });
  server = await preview({ root, logLevel: 'warn', preview: { port: PORT, strictPort: true } });
  browser = await chromium.launch({ channel: 'chromium' });
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('pageerror', (e) => assert.fail(`page error: ${e.message}`));
  await page.route('**/api/**', (route) => route.fulfill({ status: 401, json: { error: 'unauthenticated' } }));
  await page.goto(`http://localhost:${PORT}/develop`);
  await page.locator('input[type="file"]').setInputFiles(raw);
  await page.locator('canvas[data-image="edited"]').waitFor({ timeout: 120_000 });
  await page.waitForTimeout(1500);
});

after(async () => {
  await browser?.close();
  await server?.close();
});

const shot = async (name: string) => shots && (await page.screenshot({ path: join(shots, `${name}.png`) }));
const spotlight = () => page.locator('[data-spotlight]');
/** The modules the panel shows. */
const shownModules = () =>
  page.locator('aside [data-instance]').evaluateAll((els) => els.map((e) => e.querySelector('h2')?.textContent));
/** Where a module's block is on screen. */
const topOf = (id: string) =>
  page.evaluate((id) => document.querySelector(`[data-instance="${id}"]`)!.getBoundingClientRect().top, id);
/** The id of the module showing `title`. */
const idOf = (title: string) =>
  page
    .locator('aside [data-instance]')
    .filter({ has: page.getByRole('heading', { name: title, exact: true }) })
    .first()
    .getAttribute('data-instance');
/** What has the focus: a slider's label, or a tab's text. */
const focused = () =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const slider = el.closest('[data-scope="slider"][data-part="root"]');
    if (slider) return `slider ${slider.querySelector('[data-part="label"]')?.textContent}`;
    return `${el.getAttribute('role') ?? el.tagName.toLowerCase()} ${el.textContent?.trim()}`;
  });
const asideScroll = () => page.evaluate(() => document.querySelector('[data-instance]')!.closest('aside')!.scrollTop);
const spaceAbove = () =>
  page.evaluate(
    () => Number.parseFloat(document.querySelector<HTMLElement>('[data-space="above"]')!.style.height) || 0,
  );

async function open(query: string) {
  await page.keyboard.press('Control+Space');
  await spotlight().waitFor();
  await page.keyboard.type(query);
  await page.waitForTimeout(300);
}

/** Enter, checking the module stays where it is on screen. */
async function enter(title: string) {
  const id = (await idOf(title))!;
  const before = await topOf(id);
  await page.keyboard.press('Enter');
  await spotlight().waitFor({ state: 'detached' });
  assert.ok((await shownModules()).length > 3, 'the whole panel is back');
  const after = await topOf(id);
  assert.ok(Math.abs(after - before) < 1, `${title} moved from ${before} to ${after}`);
  return id;
}

test('filcon: filmic alone, then Enter focuses its contrast in place; the arrows move it', async () => {
  await open('filcon');
  assert.deepEqual(await shownModules(), ['Filmic']);
  await shot('filcon');
  await enter('Filmic');
  assert.equal(await focused(), 'slider Contrast');
  await page.keyboard.press('ArrowRight');
  await page
    .getByText(/^Filmic: contrast/)
    .first()
    .waitFor();
  // The pointer is never taken.
  assert.equal(await page.evaluate(() => document.pointerLockElement), null);
});

test('cbm and ccmix: the mixer tabs, shown and focused', async () => {
  await open('cbm');
  assert.deepEqual(await shownModules(), ['Color balance']);
  await enter('Color balance');
  assert.equal(await focused(), 'tab Mixer');
  assert.equal(await page.locator(':focus').getAttribute('aria-selected'), 'true');

  await open('ccmix');
  assert.deepEqual(await shownModules(), ['Color calibration']);
  await shot('ccmix');
  await enter('Color calibration');
  assert.equal(await focused(), 'tab Mixer');
  assert.equal(await page.locator(':focus').getAttribute('aria-selected'), 'true');
});

test('temp: a temperature slider without naming its module', async () => {
  // Back to the light tab, where calibration's temperature is.
  await open('ccwb');
  await page.keyboard.press('Enter');
  await open('temp');
  assert.match((await spotlight().getByRole('option').first().textContent())!, /Color calibration.*Temperature/);
  await enter('Color calibration');
  assert.equal(await focused(), 'slider Temperature');
});

test('the first module keeps its place with space above, which goes once scrolled away', async () => {
  await open('exp');
  assert.deepEqual(await shownModules(), ['Exposure']);
  const id = await enter('Exposure');
  assert.equal(await focused(), 'slider Exposure');
  const space = await spaceAbove();
  assert.ok(space > 20, `space above ${space}`);
  // Scrolled past it: gone, and nothing moves.
  const top = await topOf(id);
  await page.evaluate((by) => document.querySelector('[data-instance]')!.closest('aside')!.scrollBy(0, by), space + 40);
  await page.waitForTimeout(200);
  assert.equal(await spaceAbove(), 0);
  assert.ok(Math.abs((await topOf(id)) - (top - space - 40)) < 1);
});

test('Esc: back to where the panel was, nothing focused there; another match with the arrows', async () => {
  const scroll = await asideScroll();
  await open('co');
  const first = await shownModules();
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(300);
  assert.notDeepEqual(await shownModules(), first);
  await page.keyboard.press('Escape');
  await spotlight().waitFor({ state: 'detached' });
  assert.equal(await asideScroll(), scroll);
  await open('zzz');
  assert.ok(await spotlight().getByText('Nothing matches').isVisible());
  await page.keyboard.press('Escape');
});
