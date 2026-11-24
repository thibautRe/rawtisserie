/**
 * Drawing shapes in a real browser, on the production build of the public `/develop`
 * page: the path tool's bar, its preview of the next segment, and its own undo.
 *
 *   npm run test:shapes -w @rawtisserie/web
 *
 * Tests share one page, in order. PERF_RAW picks the file (default: the golden Sony ARW,
 * see scripts/fetch-golden-raws.sh); SHAPES_SHOTS=dir saves screenshots.
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
const shots = process.env.SHAPES_SHOTS;
const PORT = 4185;

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
  // The history (folded at first) shows what each edit committed.
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.waitForTimeout(1500);
});

after(async () => {
  await browser?.close();
  await server?.close();
});

const shot = async (name: string) => shots && (await page.screenshot({ path: join(shots, `${name}.png`) }));
const bar = () => page.locator('[data-path-bar]');
const apply = () => bar().getByRole('button', { name: 'Apply' });
/** The history's rows, newest first. */
const entries = () => page.getByRole('button', { name: /^Compared? with this entry$/ }).count();
/** A place on the image, as fractions of its width and height. */
async function on(x: number, y: number): Promise<[number, number]> {
  const b = (await page.locator('canvas[data-image="edited"]').boundingBox())!;
  return [b.x + b.width * x, b.y + b.height * y];
}
const previews = () => page.locator('[data-path-preview]').count();

test('the path tool has a bar like the crop’s, previews the next segment, and undoes its own nodes', async () => {
  // Exposure's mask (its settings open with it), drawn with the path tool.
  await page
    .locator('[data-scope="switch"][data-part="root"]')
    .filter({ has: page.locator('input[aria-label="Exposure mask"]') })
    .locator('[data-part="control"]')
    .click();
  // Its tools come before retouch's.
  await page.getByRole('button', { name: 'Hide the mask settings' }).waitFor();
  await page.getByRole('button', { name: /^Path/ }).first().click();
  await bar().waitFor();
  assert.equal(await apply().isDisabled(), true);
  const before = await entries();

  // A node, then the pointer elsewhere: a dashed segment shows where the next one goes.
  await page.mouse.click(...(await on(0.3, 0.3)));
  assert.equal(await previews(), 0);
  await page.mouse.move(...(await on(0.6, 0.3)));
  assert.equal(await previews(), 1);
  await page.mouse.click(...(await on(0.6, 0.3)));
  await page.mouse.move(...(await on(0.5, 0.7)));
  await shot('path-preview');
  assert.equal(await apply().isDisabled(), true);
  await page.mouse.click(...(await on(0.5, 0.7)));
  assert.equal(await apply().isEnabled(), true);

  // Undo takes the last node off, redo puts it back; the history doesn't move.
  await page.keyboard.press('ControlOrMeta+z');
  assert.equal(await apply().isDisabled(), true);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  assert.equal(await apply().isEnabled(), true);
  assert.equal(await entries(), before);

  // Apply: the shape is in the history, and the tool is left.
  await apply().click();
  await bar().waitFor({ state: 'detached' });
  await page.getByText('Exposure: mask shape added').waitFor();
  assert.equal(await entries(), before + 1);
  await shot('path-applied');
});

test('undo without nodes leaves the path tool, and leaves the history alone', async () => {
  const before = await entries();
  await page.getByRole('button', { name: /^Path/ }).first().click();
  await bar().waitFor();
  await page.mouse.click(...(await on(0.2, 0.6)));
  await page.keyboard.press('ControlOrMeta+z');
  await bar().waitFor();
  await page.keyboard.press('ControlOrMeta+z');
  await bar().waitFor({ state: 'detached' });
  assert.equal(await entries(), before);
  await page.getByText('Exposure: mask shape added').waitFor();
});

test('Cancel drops the path and leaves the tool', async () => {
  const before = await entries();
  await page.getByRole('button', { name: /^Path/ }).first().click();
  await page.mouse.click(...(await on(0.2, 0.2)));
  await page.mouse.click(...(await on(0.4, 0.2)));
  await bar().getByRole('button', { name: 'Cancel' }).click();
  await bar().waitFor({ state: 'detached' });
  assert.equal(await entries(), before);
});
