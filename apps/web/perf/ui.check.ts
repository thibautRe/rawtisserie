/**
 * The `/ui` page renders in every font and colour mode, without errors. With
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

for (const fonts of ['current', 'new'])
  for (const mode of ['dark', 'light'])
    test(`/ui with ${fonts} fonts, ${mode}`, async () => {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      // No API: the page must not need one (the developer's `/develop` doesn't either).
      await page.route('**/api/**', (route) => route.fulfill({ status: 404, json: { error: 'not found' } }));
      await page.goto(`http://localhost:${PORT}/ui?fonts=${fonts}&mode=${mode}`);
      await page.getByRole('heading', { name: 'Typography' }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      const look = await page.evaluate(() => ({
        dark: document.documentElement.classList.contains('dark'),
        body: getComputedStyle(document.body).fontFamily,
        heading: getComputedStyle(document.querySelector('h2')!).fontFamily,
      }));
      assert.equal(look.dark, mode === 'dark');
      assert.match(look.body, fonts === 'new' ? /Chivo Mono/ : /Inter/);
      assert.match(look.heading, fonts === 'new' ? /Big Shoulders/ : /Inter/);
      if (shots) {
        // The page scrolls inside the app's main box: grow the viewport to all of it.
        const height = await page.evaluate(() => document.querySelector('main > div')!.scrollHeight);
        await page.setViewportSize({ width: 1400, height });
        await page.screenshot({ path: `${shots}/ui-${fonts}-${mode}.png` });
      }
      assert.deepEqual(errors, []);
      await page.close();
    });
