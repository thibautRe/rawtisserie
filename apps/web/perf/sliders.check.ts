/**
 * How `ParamSlider` works with the slider library underneath, in a real browser on the
 * production build of the public `/develop` page. The maths is tested in `slider.test.ts`;
 * this covers what only shows up with real pointer events.
 *
 *   npm run test:sliders -w @rawtisserie/web
 *
 * Tests share one page and each uses its own slider, since a grown track stays grown.
 * PERF_RAW picks the file (default: the golden Sony ARW, see scripts/fetch-golden-raws.sh).
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
const PORT = 4181;

let server: PreviewServer;
let browser: Browser;
let page: Page;

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
});

after(async () => {
  await browser?.close();
  await server?.close();
});

const slider = (label: RegExp) =>
  page.locator('[data-scope="slider"][data-part="root"]').filter({ hasText: label }).first();
const thumb = (label: RegExp) => slider(label).locator('[data-part="thumb"]');

/** Lets the slider's microtasks and React settle. */
const settle = () => page.waitForTimeout(150);

async function value(label: RegExp) {
  await settle();
  return Number.parseFloat((await slider(label).locator('button').textContent())!);
}

/** The largest value the track covers. */
async function trackMax(label: RegExp) {
  await settle();
  return Number(await thumb(label).getAttribute('aria-valuemax'));
}

async function control(label: RegExp) {
  await slider(label).scrollIntoViewIfNeeded();
  const box = (await slider(label).locator('[data-part="control"]').boundingBox())!;
  return { y: box.y + box.height / 2, at: (x: number) => box.x + box.width * x };
}

/** Presses at `from`, and moves to `to`, as fractions of the track. Returns the release. */
async function press(label: RegExp, from: number, to = from) {
  const { y, at } = await control(label);
  await page.mouse.move(at(from), y);
  await page.mouse.down();
  await page.mouse.move(at(to), y, { steps: 6 });
  return () => page.mouse.up();
}

async function pressThumb(label: RegExp) {
  await slider(label).scrollIntoViewIfNeeded();
  const box = (await thumb(label).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
}

async function type(label: RegExp, text: string) {
  await slider(label).locator('button').click();
  await page.keyboard.type(text);
}

/**
 * The slider's state is in the history: undo then redo comes back to it. A drag that only
 * previewed wouldn't, and labels can't tell, since history merges edits in a row.
 */
async function assertCommitted(label: RegExp) {
  await settle();
  const before = await slider(label).textContent();
  await page.keyboard.press('Control+z');
  await settle();
  await page.keyboard.press('Control+Shift+z');
  await settle();
  assert.equal(await slider(label).textContent(), before);
}

test('a Ctrl drag on the track starts without a jump, and commits', async () => {
  const contrast = /^Contrast/;
  const start = await value(contrast);
  await page.keyboard.down('Control');
  const release = await press(contrast, 0.9);
  assert.equal(await value(contrast), start, 'pressing far from the thumb moves nothing');
  const { y, at } = await control(contrast);
  await page.mouse.move(at(0.1), y, { steps: 6 });
  await release();
  await page.keyboard.up('Control');
  const end = await value(contrast);
  assert.ok(end < start && end > start - 0.25, `${start} → ${end}: a tenth of 80 % of the track`);
  await assertCommitted(contrast);
});

test('a Shift drag on the track stops at its end, and commits', async () => {
  const black = /^Black level/;
  await page.keyboard.down('Shift');
  await (
    await press(black, 0.1, 0.9)
  )();
  await page.keyboard.up('Shift');
  assert.equal(await value(black), 0.1, 'the end of the track, under the hard limit of 1');
  assert.equal(await trackMax(black), 0.1);
  await assertCommitted(black);
});

test('a plain drag commits', async () => {
  const exposure = /^Exposure/;
  await (
    await press(exposure, 0.5, 0.75)
  )();
  const end = await value(exposure);
  assert.ok(end > 1.8 && end < 2.2, `${end}: three quarters of ±4`);
  await assertCommitted(exposure);
});

test('a click on a detent commits', async () => {
  const bleach = /^AgX bleach/;
  await (
    await press(bleach, 0.99)
  )();
  await settle();
  assert.match((await slider(bleach).textContent())!, /Extra$/);
  await assertCommitted(bleach);
});

test('a typed value grows the track, which keeps it through clicks and drags', async () => {
  const contrast = /^Contrast/;
  await type(contrast, '4,2');
  await page.keyboard.press('Enter');
  assert.equal(await value(contrast), 4.2);
  assert.equal(await trackMax(contrast), 4.2);
  await assertCommitted(contrast);

  await pressThumb(contrast);
  await page.mouse.up();
  assert.equal(await value(contrast), 4.2, 'a click on its thumb leaves it alone');

  await pressThumb(contrast);
  const { y, at } = await control(contrast);
  await page.mouse.move(at(0.3), y, { steps: 6 });
  assert.equal(await trackMax(contrast), 4.2, 'during the drag');
  await page.mouse.up();
  const end = await value(contrast);
  assert.ok(end < 3, `${end}: back inside the usual range`);
  assert.equal(await trackMax(contrast), 4.2, 'after it');
});

test('typing past the hard limit stops there', async () => {
  const contrast = /^Contrast/;
  await type(contrast, '99');
  await page.keyboard.press('Enter');
  assert.equal(await value(contrast), 5);
});

test('Esc cancels typing, and tells the developer not to leave', async () => {
  const exposure = /^Exposure/;
  const start = await value(exposure);
  await page.evaluate(() => {
    window.addEventListener('keydown', (e) => {
      (window as never as { __escTaken: boolean }).__escTaken = e.key === 'Escape' && e.defaultPrevented;
    });
  });
  await type(exposure, '1.5');
  await page.keyboard.press('Escape');
  assert.equal(await value(exposure), start);
  assert.equal(await page.evaluate(() => (window as never as { __escTaken: boolean }).__escTaken), true);
});

test('sliders stay bound to their instance through adding, moving and deleting', async () => {
  const menu = (title: string) => page.getByRole('button', { name: `${title} instances`, exact: true });
  const pick = async (title: string, item: RegExp) => {
    await menu(title).scrollIntoViewIfNeeded();
    await menu(title).click();
    await page.getByRole('menuitem', { name: item }).click();
    await settle();
  };
  const module = (title: string) =>
    page
      .locator('div')
      .filter({ has: page.getByRole('heading', { name: title, exact: true }) })
      .filter({ has: page.locator('[data-scope="slider"]') })
      .last();
  const radius = (title: string) =>
    module(title)
      .locator('[data-scope="slider"][data-part="root"]')
      .filter({ hasText: /^Radius/ })
      .locator('button');
  const set = async (title: string, v: string) => {
    await radius(title).click();
    await page.keyboard.type(`${v}\n`);
    await settle();
  };
  const read = async (title: string) => Number.parseFloat((await radius(title).textContent())!);

  // A kind without an instance has no menu yet; editing adds the instance.
  assert.ok(await menu('Glow').isDisabled());
  await set('Glow', '1');
  await pick('Glow', /New instance/);
  assert.equal(await read('Glow 1'), 1);
  assert.equal(await read('Glow 2'), 60);

  await set('Glow 2', '2');
  assert.equal(await read('Glow 1'), 1);
  assert.equal(await read('Glow 2'), 2);

  // Each slider follows its instance when the order changes.
  await pick('Glow 2', /Move up/);
  assert.equal(await read('Glow 1'), 2);
  assert.equal(await read('Glow 2'), 1);
  await set('Glow 2', '3');
  assert.equal(await read('Glow 1'), 2);
  assert.equal(await read('Glow 2'), 3);

  await pick('Glow 1', /Rename/);
  await page.keyboard.type('soft\n');
  await settle();
  assert.equal(await read('Glow (soft)'), 2);

  await pick('Glow (soft)', /Delete/);
  assert.equal(await read('Glow'), 3);
  assert.equal(await page.getByRole('heading', { name: 'Glow (soft)' }).count(), 0);
  await page.keyboard.press('Control+z');
  await settle();
  assert.equal(await read('Glow (soft)'), 2);
});

test('instances of a module do not affect each other', async () => {
  const section = (title: string) =>
    page
      .locator('div')
      .filter({ has: page.getByRole('heading', { name: title, exact: true }) })
      .filter({ has: page.locator('[data-scope="slider"]') })
      .last();
  const addSecond = async (kind: string) => {
    const toggle = section(kind).getByRole('checkbox', { name: `Enable ${kind}` });
    if (!(await toggle.isChecked())) await section(kind).locator('[data-scope="switch"][data-part="control"]').click();
    await settle();
    await page.getByRole('button', { name: `${kind} instances`, exact: true }).click();
    await page.getByRole('menuitem', { name: /New instance/ }).click();
    await settle();
  };
  const sliders = (title: string) => section(title).locator('[data-scope="slider"][data-part="root"]');

  // Every slider of the second instance moves it and leaves the first alone.
  for (const kind of ['Exposure', 'Color calibration', 'Color balance', 'Contrast equalizer', 'Color primaries']) {
    await addSecond(kind);
    const count = await sliders(`${kind} 2`).count();
    assert.ok(count > 0, kind);
    for (let i = 0; i < count; i++) {
      const first = await section(`${kind} 1`).textContent();
      const slider = sliders(`${kind} 2`).nth(i);
      const before = await slider.textContent();
      await slider.scrollIntoViewIfNeeded();
      const box = (await slider.locator('[data-part="control"]').boundingBox())!;
      // Varied positions: some sliders move others (colour balance's Global moves its
      // ranges), which must still change when clicked next.
      const at = [0.8, 0.3, 0.65, 0.15][i % 4]!;
      await page.mouse.click(box.x + box.width * at, box.y + box.height / 2);
      await settle();
      assert.notEqual(await slider.textContent(), before, `${kind} slider ${i}`);
      assert.equal(await section(`${kind} 1`).textContent(), first, `${kind} slider ${i}`);
    }
  }

  // Neither does what they show.
  const swatch = (title: string, name: string) => section(title).getByRole('radio', { name });
  await swatch('Color primaries 2', 'yellow').click();
  await settle();
  assert.equal(await swatch('Color primaries 1', 'red').getAttribute('aria-checked'), 'true');
  assert.equal(await swatch('Color primaries 2', 'yellow').getAttribute('aria-checked'), 'true');
  await section('Color primaries 2')
    .getByRole('button', { name: /Gamut and smoothing/ })
    .click();
  await settle();
  assert.equal(
    await sliders('Color primaries 1')
      .filter({ hasText: /^White level/ })
      .count(),
    0,
  );
  assert.equal(
    await sliders('Color primaries 2')
      .filter({ hasText: /^White level/ })
      .count(),
    1,
  );
  const curve = (title: string) => section(title).getByRole('combobox', { name: 'Curve' });
  await curve('Contrast equalizer 2').selectOption('edges');
  await settle();
  assert.equal(await curve('Contrast equalizer 1').inputValue(), 'luma');
  assert.equal(await curve('Contrast equalizer 2').inputValue(), 'edges');
  const calibrationTab = (title: string, name: string) => section(title).getByRole('tab', { name });
  await calibrationTab('Color calibration 2', 'Output').click();
  await settle();
  assert.equal(await calibrationTab('Color calibration 1', 'CAT').getAttribute('aria-selected'), 'true');
  assert.equal(
    await sliders('Color calibration 2')
      .filter({ hasText: /^Green/ })
      .count(),
    3,
  );
  assert.equal(
    await sliders('Color calibration 1')
      .filter({ hasText: /^Green/ })
      .count(),
    0,
  );

  // A curve edit stays in its instance too (both showing the same curve).
  await curve('Contrast equalizer 2').selectOption('luma');
  await settle();
  const graph = (title: string) => section(title).getByRole('group', { name: 'Luminance contrast' });
  const [first, second] = [
    await graph('Contrast equalizer 1').innerHTML(),
    await graph('Contrast equalizer 2').innerHTML(),
  ];
  await graph('Contrast equalizer 2').scrollIntoViewIfNeeded();
  const box = (await graph('Contrast equalizer 2').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.2);
  await settle();
  assert.notEqual(await graph('Contrast equalizer 2').innerHTML(), second);
  assert.equal(await graph('Contrast equalizer 1').innerHTML(), first);
});
