/**
 * Raw denoise models (roadmap 3.5): ansel-denoise's networks, fetched and checked at
 * build time by `scripts/fetch-denoise-models.sh` (pinned by hash). The browser
 * downloads one the first time a recipe uses it. Public, like built-in LUTs: the
 * developer works without an account. A model's id never names another file, so they
 * can be cached for good.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.ts';

const ModelId = z.object({ id: z.string().regex(/^denoise-(quarter|half|large)-(single|multi)-v[1-9][0-9]*$/) });

export async function denoiseRoutes(app: FastifyInstance) {
  app.get('/api/denoise-models/:id', async (request, reply) => {
    const parsed = ModelId.safeParse(request.params);
    if (!parsed.success) return reply.code(404).send({ error: 'Model not found' });
    const file = path.join(config.denoiseModelsDir, `${parsed.data.id}.anselnn`);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) return reply.code(404).send({ error: 'Model not found' });
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-length', info.size)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(createReadStream(file));
  });
}
