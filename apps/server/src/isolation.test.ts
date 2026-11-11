import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { ISOLATION_REPORT_ONLY_HEADERS, REPORT_PATH, isolationReports } from './isolation.ts';

async function setup() {
  const logged: unknown[] = [];
  const stream = { write: (line: string) => logged.push(JSON.parse(line)) };
  const app = Fastify({ logger: { level: 'warn', stream } });
  await isolationReports(app);
  app.get('/page', async () => 'ok');
  return { app, logged };
}

test('every response says what cross-origin isolation would block, without enforcing it', async () => {
  const { app } = await setup();
  const res = await app.inject({ method: 'GET', url: '/page' });
  for (const [name, value] of Object.entries(ISOLATION_REPORT_ONLY_HEADERS)) {
    assert.equal(res.headers[name.toLowerCase()], value);
  }
  assert.equal(res.headers['cross-origin-opener-policy'], undefined);
  assert.equal(res.headers['cross-origin-embedder-policy'], undefined);
});

test('violation reports are logged', async () => {
  const { app, logged } = await setup();
  const res = await app.inject({
    method: 'POST',
    url: REPORT_PATH,
    headers: { 'content-type': 'application/reports+json' },
    payload: JSON.stringify([
      {
        type: 'coep',
        url: 'https://example.test/develop',
        body: {
          type: 'corp',
          blockedURL: 'https://cdn.example.test/a.png',
          destination: 'image',
          disposition: 'reporting',
        },
      },
    ]),
  });
  assert.equal(res.statusCode, 204);
  const entry = logged.find((l) => (l as { isolationReport?: unknown }).isolationReport) as {
    isolationReport: Record<string, string>;
  };
  assert.equal(entry.isolationReport.blocked, 'https://cdn.example.test/a.png');
  assert.equal(entry.isolationReport.violation, 'corp');

  // Our own workers, reported only because report-only mode doesn't enforce their policy.
  const before = logged.length;
  await app.inject({
    method: 'POST',
    url: REPORT_PATH,
    headers: { 'content-type': 'application/reports+json' },
    payload: JSON.stringify([
      {
        type: 'coep',
        url: 'https://example.test/develop',
        body: { type: 'worker initialization', blockedURL: 'https://example.test/assets/pipeline.worker.js' },
      },
    ]),
  });
  assert.equal(logged.length, before);

  const garbage = await app.inject({
    method: 'POST',
    url: REPORT_PATH,
    headers: { 'content-type': 'application/reports+json' },
    payload: 'not json',
  });
  assert.equal(garbage.statusCode, 204);
});
