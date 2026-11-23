import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { HttpError } from './errors.ts';
import { RATE_LIMITS, checkCount, rateLimits } from './limits.ts';

/** An app with the rate limits, `request.user` set from the `x-user` header (as `authPlugin` would). */
async function setup() {
  const app = Fastify({ trustProxy: true });
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    const id = request.headers['x-user'];
    request.user = typeof id === 'string' ? ({ id } as NonNullable<typeof request.user>) : null;
  });
  await rateLimits(app);
  app.post('/api/auth/login', { config: { rateLimit: RATE_LIMITS.login } }, async () => 'ok');
  app.get('/api/things', async () => 'ok');
  app.get('/api/file', { config: { rateLimit: false } }, async () => 'ok');
  app.put('/api/uploads/:id', { config: { rateLimit: RATE_LIMITS.uploads } }, async () => 'ok');
  app.get('/assets/app.js', async () => 'ok');
  return app;
}

const statuses = async (n: number, send: () => Promise<{ statusCode: number }>) => {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await send()).statusCode);
  return out;
};

test('logins are limited per address, behind a proxy too', async () => {
  const app = await setup();
  const login = (ip: string) => () =>
    app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': ip } });
  const first = await statuses(RATE_LIMITS.login.max + 1, login('203.0.113.1'));
  assert.deepEqual(first.slice(0, -1), Array(RATE_LIMITS.login.max).fill(200));
  assert.equal(first.at(-1), 429);
  // Another address isn't held back by the first one.
  assert.equal((await login('203.0.113.2')()).statusCode, 200);
});

test('the API is limited per user, files and the web app are not', async () => {
  const app = await setup();
  const max = RATE_LIMITS.api.max;
  const as = (user: string, url: string) => () => app.inject({ url, headers: { 'x-user': user } });
  const results = await statuses(max + 1, as('alice', '/api/things'));
  assert.equal(results.filter((s) => s === 200).length, max);
  assert.equal(results.at(-1), 429);
  // Another user, on the same address, still gets through.
  assert.equal((await as('bob', '/api/things')()).statusCode, 200);
  // Opted out, and not the API.
  assert.equal((await as('alice', '/api/file')()).statusCode, 200);
  assert.equal((await as('alice', '/assets/app.js')()).statusCode, 200);
});

test("an import's uploads are counted apart from the API, and the API's requests apart from them", async () => {
  const app = await setup();
  const as = (method: 'GET' | 'PUT', url: string) => () => app.inject({ method, url, headers: { 'x-user': 'alice' } });
  const api = await statuses(RATE_LIMITS.api.max + 1, as('GET', '/api/things'));
  assert.equal(api.at(-1), 429);
  // The API's budget is spent; uploads still go, up to their own.
  const chunks = await statuses(RATE_LIMITS.uploads.max + 1, as('PUT', '/api/uploads/1'));
  assert.equal(chunks.filter((s) => s === 200).length, RATE_LIMITS.uploads.max);
  const refused = await as('PUT', '/api/uploads/1')();
  assert.equal(refused.statusCode, 429);
  // Told when to try again (the app waits that long).
  assert.ok(Number(refused.headers['retry-after']) > 0);
});

test('counts stop at their maximum', () => {
  assert.doesNotThrow(() => checkCount(9, 10, 'things'));
  assert.throws(
    () => checkCount(10, 10, 'things'),
    (err) => err instanceof HttpError && err.statusCode === 403 && /at most 10 things/.test(err.message),
  );
});
