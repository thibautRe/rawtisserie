/**
 * The `/ui` page renders in both colour modes, with the app's fonts,, without errors. With
 * `UI_SHOTS=dir`, saves a screenshot of the whole page in each.
 *
 *   npm run test:ui -w @rawtisserie/web
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium } from 'playwright';
import { type PreviewServer, build, preview } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const PORT = 4183;
const shots = process.env.UI_SHOTS;

let server: PreviewServer;
let browser: Browser;

before(async () => {
  await build({ root, logLevel: 'error' });
  server = await preview({ root, logLevel: 'warn', preview: { port: PORT, strictPort: true } });
  browser = await chromium.launch({ channel: 'chromium' });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

for (const mode of ['dark', 'light'])
  test(`/ui, ${mode}`, async () => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // No API: the page must not need one (the developer's `/develop` doesn't either).
    await page.route('**/api/**', (route) => route.fulfill({ status: 404, json: { error: 'not found' } }));
    await page.goto(`http://localhost:${PORT}/ui?mode=${mode}`);
    await page.getByRole('heading', { name: 'Typography' }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    const look = await page.evaluate(() => ({
      dark: document.documentElement.classList.contains('dark'),
      body: getComputedStyle(document.body).fontFamily,
      heading: getComputedStyle(document.querySelector('h2')!).fontFamily,
      label: getComputedStyle([...document.querySelectorAll('h2')].find((h) => h.textContent === 'Colour label')!)
        .fontFamily,
      numeric: getComputedStyle(document.querySelector('[aria-label^="Exposure:"]')!).fontFamily,
    }));
    assert.equal(look.dark, mode === 'dark');
    assert.match(look.body, /Geologica/);
    assert.match(look.heading, /Geologica/);
    assert.match(look.label, /Geologica/);
    assert.match(look.numeric, /Lilex/);
    if (shots) {
      // The page scrolls inside the app's main box: grow the viewport to all of it.
      const height = await page.evaluate(() => document.querySelector('main > div')!.scrollHeight);
      await page.setViewportSize({ width: 1400, height });
      await page.screenshot({ path: `${shots}/ui-${mode}.png` });
    }
    assert.deepEqual(errors, []);
    await page.close();
  });

test('/ui on a phone: renders, and a panel opens as a sheet that fits', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/**', (route) => route.fulfill({ status: 404, json: { error: 'not found' } }));
  await page.goto(`http://localhost:${PORT}/ui`);
  await page.getByRole('heading', { name: 'Phones' }).waitFor();
  await page.getByRole('button', { name: 'Open a panel as a sheet' }).tap();
  const sheet = page.getByRole('dialog', { name: 'Details' });
  await sheet.getByRole('radio', { name: '3 stars (3)' }).waitFor();
  await page.waitForTimeout(400); // its opening animation
  const box = (await sheet.boundingBox())!;
  assert.ok(box.x >= 0 && box.x + box.width <= 390, `the sheet is ${box.width} px wide at ${box.x}`);
  if (shots) await page.screenshot({ path: `${shots}/ui-phone-sheet.png` });
  assert.deepEqual(errors, []);
  await page.close();
});

test('the manager dialog renames and deletes', async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/**', (route) => route.fulfill({ status: 404, json: { error: 'not found' } }));
  await page.goto(`http://localhost:${PORT}/ui`);
  await page.getByRole('button', { name: 'Manage styles…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Styles' });
  await dialog.waitFor();

  // Rename with Enter.
  await dialog.getByRole('button', { name: 'Rename Portra-ish' }).click();
  await dialog.getByRole('textbox', { name: 'New name for Portra-ish' }).fill('Portra 400');
  await page.keyboard.press('Enter');
  await dialog.getByText('Portra 400').waitFor();

  // A name that's taken says so and stays in the field.
  await dialog.getByRole('button', { name: 'Rename Portra 400' }).click();
  const field = dialog.getByRole('textbox', { name: 'New name for Portra 400' });
  await field.fill('bleach BYPASS');
  await page.keyboard.press('Enter');
  await dialog.getByText('There is already a style named “bleach BYPASS”').waitFor();
  assert.equal(await field.inputValue(), 'bleach BYPASS');

  // Escape leaves the field, not the dialog.
  await page.keyboard.press('Escape');
  await field.waitFor({ state: 'detached' });
  assert.ok(await dialog.isVisible());
  if (shots) await page.screenshot({ path: `${shots}/ui-manager.png` });

  // Deleting asks once more.
  await dialog.getByRole('button', { name: 'Delete Bleach bypass' }).click();
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await dialog.getByText('Bleach bypass').waitFor({ state: 'detached' });
  assert.equal(await dialog.getByRole('button', { name: /^Rename / }).count(), 2);

  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
  await page.close();
});
