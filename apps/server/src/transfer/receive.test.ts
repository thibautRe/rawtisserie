import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import type { RenderQueue } from '../render/queue.ts';
import { receiveRoutes } from './receive.ts';

test('the receiving side reads packed LUTs (`/api/transfer/luts`), not only JSON', async () => {
  const app = Fastify();
  let accepts = false;
  await app.register(async (scope) => {
    await receiveRoutes(scope, { renderQueue: {} as RenderQueue });
    // A plugin's own: without it, a sent LUT is answered 415 Unsupported Media Type.
    accepts = scope.hasContentTypeParser('application/octet-stream');
  });
  await app.close();
  assert.ok(accepts);
});
