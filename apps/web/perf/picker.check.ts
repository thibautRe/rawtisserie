/**
 * The colour picker (roadmap 2.7) in a real browser, on the production build of the
 * public `/develop` page: the pixel under the pointer in the status bar, the scopes and
 * the graphs of the tone curve and colour balance, and samples pinned with the pipette.
 *
 *   npm run test:picker -w @rawtisserie/web
 *
 * Tests share one page, in order. PERF_RAW picks the file (default: the golden Sony ARW,
 * see scripts/fetch-golden-raws.sh).
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type Browser, type Page, chromium } from 'playwright';
import { type PreviewServer, build, preview } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const raw =
  process.env.PERF_RAW ??
  fileURLToPath(new URL('../../../crates/pipeline/tests/golden/raws/sony-ilce-7m3.arw', import.meta.url));
const PORT = 4182;

let server: PreviewServer;
let browser: Browser;
let page: Page;
/** The image on screen. */
let image: { x: number; y: number; width: number; height: number };

before(async () => {
  assert.ok(existsSync(raw), `No RAW file at ${raw}: run ./scripts/fetch-golden-raws.sh or set PERF_RAW.`);
  await build({ root, logLevel: 'error' });
  server = await preview({ root, logLevel: 'warn', preview: { port: PORT, strictPort: true } });
  browser = await chromium.launch({ channel: 'chromium' });
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('pageerror', (e) => assert.fail(`page error: ${e.message}`));
  await page.route('**/api/**', (route) => route.fulfill({ status: 401, json: { error: 'unauthenticated' } }));
  await page.goto(`http://localhost:${PORT}/develop`);
  await page.locator('input[type="file"]').setInputFiles(raw);
  await page.locator('canvas').first().waitFor({ timeout: 120_000 });
  await page.waitForTimeout(1500);
  // The largest canvas: the image (the others are the scope and the zoomed region).
  const boxes = await page.locator('canvas').evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }),
  );
  image = boxes.sort((a, b) => b.width * b.height - a.width * a.height)[0]!;
});

after(async () => {
  await browser?.close();
  await server?.close();
});

const at = (u: number, v: number) => [image.x + image.width * u, image.y + image.height * v] as const;
const readout = () => page.locator('[data-pixel-readout]');

test('the pixel under the pointer shows in the status bar, and goes when it leaves', async () => {
  await page.mouse.move(...at(0.5, 0.5), { steps: 3 });
  await readout().waitFor();
  const first = await readout().innerText();
  assert.match(first, /RGB\s+\d+\s+\d+\s+\d+/);
  assert.match(first, /L \d+\s+C \d+\s+h \d+°/);
  assert.match(first, /[+−]?\d+\.\d EV/);
  await page.mouse.move(...at(0.8, 0.15), { steps: 3 });
  await page.waitForFunction((before) => document.querySelector('[data-pixel-readout]')?.textContent !== before, first);
  await page.mouse.move(5, 5);
  await readout().waitFor({ state: 'detached' });
});

test("the readout's values keep their width whatever their digits", async () => {
  const widths = () =>
    readout().evaluate((el) => [...el.querySelectorAll('p')].map((p) => Math.round(p.getBoundingClientRect().width)));
  // A dark corner and a bright sky: values from 1 to 3 digits, EV either side of 0.
  const seen = new Set<string>();
  for (const [u, v] of [
    [0.05, 0.95],
    [0.5, 0.05],
    [0.6, 0.6],
  ] as const) {
    await page.mouse.move(...at(u, v), { steps: 2 });
    await page.waitForTimeout(250);
    seen.add(JSON.stringify(await widths()));
  }
  assert.equal(seen.size, 1, [...seen].join(' vs '));
});

test('zoomed in to 100 % and back to fit, the picker reads the whole image again', async () => {
  // Middle click: 100 % on a point, again for fit.
  await page.mouse.click(...at(0.5, 0.5), { button: 'middle' });
  const zoom = page.locator('button[title^="Zoom"]');
  await page.waitForFunction(() => document.querySelector('button[title^="Zoom"]')?.textContent?.includes('%'));
  await page.waitForTimeout(2500);
  await page.mouse.click(...at(0.5, 0.5), { button: 'middle' });
  await page.waitForFunction(() => document.querySelector('button[title^="Zoom"]')?.textContent?.includes('Fit'));
  assert.match(await zoom.innerText(), /Fit/);
  await page.mouse.move(5, 5);
  await readout().waitFor({ state: 'detached' });
  // Far from where the 100 % view was.
  await page.mouse.move(...at(0.08, 0.9), { steps: 2 });
  await readout().waitFor({ timeout: 10_000 });
});

test('the scopes mark it: waveform, parade and vectorscope', async () => {
  for (const mode of ['Waveform', 'RGB parade', 'Vectorscope']) {
    await page.getByRole('button', { name: mode }).click();
    await page.mouse.move(...at(0.3, 0.6), { steps: 3 });
    await page.locator('[data-scope-marker]').waitFor();
  }
  await page.mouse.move(5, 5);
  await page.locator('[data-scope-marker]').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Waveform' }).click();
});

test('the tone curve and colour balance mark what they read there', async () => {
  await page.locator('[aria-label="Enable Tones"]').first().click({ force: true });
  await page.getByRole('tab', { name: 'Settings' }).first().click();
  await page.mouse.move(...at(0.5, 0.5), { steps: 3 });
  await page.locator('[data-curve-marks]').first().waitFor();
  await page.locator('[data-range-mark]').first().waitFor();
});

test('the pipette pins samples (I), a click on one removes it, Esc stops', async () => {
  const pipette = page.getByRole('button', { name: 'Pin samples' });
  await page.mouse.move(...at(0.5, 0.5));
  await page.keyboard.press('i');
  assert.equal(await pipette.getAttribute('aria-pressed'), 'true');
  await page.mouse.click(...at(0.25, 0.4));
  await page.mouse.click(...at(0.7, 0.7));
  await page.locator('[data-pinned-sample="2"]').waitFor();
  // Values for both, the image not moved by the row showing.
  for (const text of await page.locator('[data-pinned-sample]').allInnerTexts()) assert.match(text, /RGB\s+\d+/);
  const centre = await page
    .locator('[data-pin="1"] > div')
    .first()
    .evaluate((e) => {
      const r = e.getBoundingClientRect();
      return [r.x + r.width / 2, r.y + r.height / 2];
    });
  const [x, y] = at(0.25, 0.4);
  assert.ok(Math.abs(centre[0]! - x) <= 1.5 && Math.abs(centre[1]! - y) <= 1.5, `pin at ${centre}, clicked ${[x, y]}`);
  // A click on pin 1 removes it (the pins are zero-size anchors: attached, not visible).
  await page.mouse.click(...at(0.25, 0.4));
  await page.waitForFunction(() => document.querySelectorAll('[data-pin]').length === 1);
  await page.keyboard.press('Escape');
  assert.equal(await pipette.getAttribute('aria-pressed'), 'false');
  // Without the pipette, a click pins nothing.
  await page.mouse.click(...at(0.4, 0.4));
  await page.waitForTimeout(200);
  assert.equal(await page.locator('[data-pin]').count(), 1);
  await page.getByRole('button', { name: 'Clear samples' }).click();
  await page.locator('[data-pinned-samples]').waitFor({ state: 'detached' });
});

test('zoomed in to 100 %, the pipette pins too, and a drag pans rather than pins', async () => {
  await page.mouse.click(...at(0.5, 0.5), { button: 'middle' });
  await page.waitForFunction(() => document.querySelector('button[title^="Zoom"]')?.textContent?.includes('%'));
  await page.waitForTimeout(1500);
  await page.keyboard.press('i');
  await page.mouse.click(...at(0.45, 0.45));
  await page.locator('[data-pinned-sample="1"]').waitFor();
  assert.match(await page.locator('[data-pinned-sample="1"]').innerText(), /RGB\s+\d+/);
  // A drag pans.
  await page.mouse.move(...at(0.6, 0.6));
  await page.mouse.down();
  await page.mouse.move(...at(0.5, 0.5), { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  assert.equal(await page.locator('[data-pin]').count(), 1);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Clear samples' }).click();
  await page.mouse.click(...at(0.5, 0.5), { button: 'middle' });
  await page.waitForFunction(() => document.querySelector('button[title^="Zoom"]')?.textContent?.includes('Fit'));
});
