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
  page
    .locator('aside [data-instance]')
    .evaluateAll((els) => els.map((e) => e.querySelector('h2, h3, h4, h5, h6')?.textContent));
/** The history's entries, newest first. */
const historyLabels = () => page.locator('text=/^\\d+$/').count();
/** What the spotlight says the bound slider is and shows. */
const bound = async () => (await spotlight().locator('text=/^↔ /').textContent())?.slice(2);
const boundValue = () => spotlight().locator('text=/^↔ /').locator('xpath=following-sibling::*[1]').textContent();

async function open(query: string) {
  await page.mouse.move(800, 500);
  await page.keyboard.press('Control+Space');
  await spotlight().waitFor();
  await page.keyboard.type(query);
  await page.waitForTimeout(300);
}

/** Moves the mouse by `dx` pixels, in steps. */
async function nudge(dx: number) {
  for (let i = 0; i < 10; i++) {
    await page.mouse.move(800 + ((i + 1) * dx) / 10, 500);
    await page.waitForTimeout(16);
  }
}

test('filcon: filmic alone in the panel, its contrast driven by the mouse, Enter applies', async () => {
  await open('filcon');
  assert.deepEqual(await shownModules(), ['Filmic']);
  assert.equal(await bound(), 'Contrast');
  const before = Number(await boundValue());
  await nudge(150);
  await shot('filcon');
  const after = Number(await boundValue());
  assert.ok(after > before, `contrast ${before} → ${after}`);
  await page.keyboard.press('Enter');
  await spotlight().waitFor({ state: 'detached' });
  // The whole panel again, and the change in the history.
  assert.ok((await shownModules()).length > 3);
  await page
    .getByText(/^Filmic: contrast/)
    .first()
    .waitFor();
});

test('cbmb: colour balance on its mixer tab, its blue hue bound; Esc puts it back', async () => {
  await open('cbmb');
  assert.deepEqual(await shownModules(), ['Color balance']);
  assert.equal(await bound(), 'Blue hue');
  const before = await boundValue();
  await nudge(-120);
  assert.notEqual(await boundValue(), before);
  await shot('cbmb');
  await page.keyboard.press('Escape');
  await spotlight().waitFor({ state: 'detached' });
  assert.equal(
    await page
      .getByText(/^Color balance/)
      .filter({ hasText: /hue/i })
      .count(),
    0,
  );
});

test('exp, and a click applies', async () => {
  await open('exp');
  assert.deepEqual(await shownModules(), ['Exposure']);
  assert.equal(await bound(), 'Exposure');
  await nudge(60);
  await page.mouse.down();
  await page.mouse.up();
  await spotlight().waitFor({ state: 'detached' });
  await page
    .getByText(/^Exposure: ev/)
    .first()
    .waitFor();
});

test('another match with the arrows, and a query no slider takes', async () => {
  await open('co');
  const first = await shownModules();
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(300);
  assert.notDeepEqual(await shownModules(), first);
  await page.keyboard.press('Escape');
  await open('expzz');
  assert.ok(
    await spotlight()
      .getByText(/No slider matches|Nothing matches/)
      .isVisible(),
  );
  await page.keyboard.press('Escape');
  await spotlight().waitFor({ state: 'detached' });
});
