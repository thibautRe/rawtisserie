/**
 * Compare (roadmap M5) in a real browser, on the production build of the public
 * `/develop` page: the edited image beside another history entry, split by a divider or
 * side by side, with the zoom moving both.
 *
 *   npm run test:compare -w @rawtisserie/web
 *
 * Tests share one page, in order. PERF_RAW picks the file (default: the golden Sony ARW,
 * see scripts/fetch-golden-raws.sh); COMPARE_SHOTS=dir saves screenshots of each layout.
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
const shots = process.env.COMPARE_SHOTS;
const PORT = 4183;

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

const edited = () => page.locator('canvas[data-image="edited"]');
const compared = () => page.locator('canvas[data-image="compared"]');
const box = async (l: ReturnType<Page['locator']>) => (await l.boundingBox())!;

/** The mean luminance (0–255) of what a canvas shows, read through a 2D canvas. */
const brightness = (l: ReturnType<Page['locator']>) =>
  l.evaluate((c: HTMLCanvasElement) => {
    const w = 64;
    const h = Math.max(1, Math.round((64 * c.height) / Math.max(1, c.width)));
    const ctx = Object.assign(document.createElement('canvas'), { width: w, height: h }).getContext('2d')!;
    ctx.drawImage(c, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
    return sum / (w * h);
  });

/** Waits until the compared image has been rendered and shows. */
async function comparedShown() {
  await page.waitForFunction(() => {
    const c = document.querySelector<HTMLCanvasElement>('canvas[data-image="compared"]');
    const win = c?.parentElement?.parentElement;
    return !!c && c.width > 1 && !!win && getComputedStyle(win).visibility === 'visible' && win.offsetWidth > 0;
  });
}

const shot = async (name: string) => shots && (await page.screenshot({ path: join(shots, `${name}.png`) }));

test('Y compares the edited image with its original, split by a divider', async () => {
  // A clear edit: +2 EV.
  const exposure = page
    .locator('[data-scope="slider"][data-part="root"]')
    .filter({ hasText: /^Exposure/ })
    .first();
  await exposure.scrollIntoViewIfNeeded();
  await exposure.locator('button').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('2');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  await page.mouse.move(5, 500);

  await page.keyboard.press('y');
  await comparedShown();
  await page.waitForTimeout(500);
  // Over each other, the same size: the same framing.
  const [a, b] = [await box(edited()), await box(compared())];
  assert.deepEqual([a.x, a.y, a.width, a.height].map(Math.round), [b.x, b.y, b.width, b.height].map(Math.round));
  // The original is darker than the edit.
  const [lit, original] = [await brightness(edited()), await brightness(compared())];
  assert.ok(original < lit - 10, `original ${original} vs edited ${lit}`);
  // Labelled: the original on the left of the divider, the edit on its right.
  await page.locator('[data-split-divider]').getByText('Original').waitFor();
  await page.locator('[data-split-divider]').getByText('Current').waitFor();
  await shot('split');
});

test('the divider moves, and only the left of it shows the compared image', async () => {
  const win = compared().locator('xpath=../..');
  const clip = () => win.evaluate((el) => el.style.clipPath);
  const area = await box(page.locator('[data-split-divider]'));
  const knob = page.locator('[data-split-divider] svg').first();
  const k = await box(knob);
  const before = await clip();
  await page.mouse.move(k.x + k.width / 2, k.y + k.height / 2);
  await page.mouse.down();
  await page.mouse.move(area.x + area.width * 0.25, k.y + k.height / 2, { steps: 5 });
  await page.mouse.up();
  const after = await clip();
  assert.notEqual(after, before);
  // Three quarters of the window hidden on the right.
  const right = Number.parseFloat(after.match(/inset\(0(?:px)? ([\d.]+)px/)![1]!);
  assert.ok(Math.abs(right - area.width * 0.75) < 4, `clip ${after} for a window of ${area.width}`);
});

test('in the assessment mode, the divider crosses the white frame and the grey around it', async () => {
  await page.keyboard.press('ControlOrMeta+b');
  const win = compared().locator('xpath=../..');
  // The window's frame comes in.
  await page.waitForFunction(() => {
    const c = document.querySelector('canvas[data-image="compared"]')!.parentElement!.parentElement!;
    return Number.parseFloat(getComputedStyle(c).borderTopWidth) > 0;
  });
  await page.waitForTimeout(500);
  const area = await box(page.locator('[data-split-divider]'));
  const w = await box(win);
  // The whole pane: taller and wider than the framed image.
  assert.ok(area.height > w.height + 20 && area.width > w.width + 20, `${JSON.stringify(area)} ${JSON.stringify(w)}`);
  // `inset(0 Npx 0 0)`, which the browser writes `inset(0px)` when nothing is hidden.
  const hidden = async () => {
    const clip = await win.evaluate((el) => el.style.clipPath);
    return Number.parseFloat(/inset\(0(?:px)? ([\d.]+)px/.exec(clip)?.[1] ?? '0');
  };
  const drag = async (x: number) => {
    const k = await box(page.locator('[data-split-divider] svg').first());
    await page.mouse.move(k.x + k.width / 2, k.y + k.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, k.y + k.height / 2, { steps: 5 });
    await page.mouse.up();
  };
  // Past the frame on the left: none of the compared image; on the right: all of it.
  await drag(w.x - 10);
  assert.ok(Math.abs((await hidden()) - w.width) < 2, `hidden ${await hidden()} of ${w.width}`);
  await drag(w.x + w.width + 10);
  assert.equal(await hidden(), 0);
  // Within the frame's left edge: the frame shows left of the divider.
  await drag(w.x + 4);
  assert.ok(Math.abs((await hidden()) - (w.width - 4)) < 2, `hidden ${await hidden()}`);
  await shot('assessment-split');
  await page.mouse.move(5, 500);
  await page.keyboard.press('ControlOrMeta+b');
  await page.waitForFunction(() => {
    const c = document.querySelector('canvas[data-image="compared"]')!.parentElement!.parentElement!;
    return Number.parseFloat(getComputedStyle(c).borderTopWidth) === 0;
  });
});

/** Waits until the comparison is off: the compared pane is hidden. */
const compareOff = () =>
  page.waitForFunction(() => {
    const c = document.querySelector('canvas[data-image="compared"]')!;
    return c.parentElement!.parentElement!.parentElement!.offsetWidth === 0;
  });

test('the Compare button, pressed while on, and Esc turn the comparison off', async () => {
  const button = page.getByRole('button', { name: 'Compare', exact: true });
  assert.equal(await button.getAttribute('aria-pressed'), 'true');
  await button.click();
  await compareOff();
  assert.equal(await button.getAttribute('aria-pressed'), 'false');
  await button.click();
  await comparedShown();
  await page.mouse.move(5, 500);
  await page.keyboard.press('Escape');
  await compareOff();
  await page.keyboard.press('y');
  await comparedShown();
});

test('side by side, each image has its half and the zoom moves both', async () => {
  await page.getByRole('button', { name: 'Compare options' }).click();
  // Choosing closes the menu (Esc now would leave the comparison).
  await page.getByRole('menuitemradio', { name: 'Side by side' }).click();
  await page.waitForFunction(() => {
    const [e, c] = ['edited', 'compared'].map((n) =>
      document.querySelector(`canvas[data-image="${n}"]`)!.getBoundingClientRect(),
    );
    return c!.right <= e!.left && c!.width > 100 && Math.abs(c!.width - e!.width) < 2;
  });
  await comparedShown();
  await page.waitForTimeout(500);
  await shot('side-by-side');

  const transforms = () =>
    page.evaluate(() =>
      ['edited', 'compared'].map(
        (n) => document.querySelector<HTMLElement>(`canvas[data-image="${n}"]`)!.parentElement!.style.transform,
      ),
    );
  // Zoom on the edited image, then on the compared one: both move together.
  const e = await box(edited());
  await page.mouse.move(e.x + e.width / 2, e.y + e.height / 2);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(300);
  const [t1, c1] = await transforms();
  assert.notEqual(t1, '');
  assert.equal(c1, t1);
  const c = await box(compared());
  await page.mouse.move(c.x + c.width / 3, c.y + c.height / 3);
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(300);
  const [t2, c2] = await transforms();
  assert.notEqual(t2, t1);
  assert.equal(c2, t2);
  // The zoomed-in regions of both come in.
  await page.waitForTimeout(2500);
  await shot('side-by-side-zoomed');
});

test('a history entry picked in the panel is compared with; its button again or Y turns it off', async () => {
  // Newest first: entry 1, the automatic recipe, is the second.
  await page.getByRole('button', { name: 'Compare with this entry' }).nth(1).click({ force: true });
  await page.getByText(/^1\. Defaults/).waitFor();
  await page.getByRole('button', { name: 'Compared with this entry' }).waitFor();
  // Its button again: off.
  await page.getByRole('button', { name: 'Compared with this entry' }).click({ force: true });
  await compareOff();
  await page.getByRole('button', { name: 'Compare with this entry' }).nth(1).click({ force: true });
  await page.getByRole('button', { name: 'Compared with this entry' }).waitFor();
  await page.keyboard.press('y');
  await compareOff();
  // The edited image has the whole viewport again.
  const e = await box(edited());
  assert.ok(e.width > 700, `edited image ${e.width} wide`);
});
