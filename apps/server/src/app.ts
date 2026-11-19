import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError } from 'fastify';
import { ZodError } from 'zod';
import { accountRoutes } from './accounts/routes.ts';
import { authPlugin, authRoutes } from './auth/routes.ts';
import { config } from './config.ts';
import { exportRoutes } from './exports/routes.ts';
import { isolationReports } from './isolation.ts';
import { rateLimits } from './limits.ts';
import { denoiseRoutes } from './denoise/routes.ts';
import { lutRoutes } from './luts/routes.ts';
import { photoRoutes } from './photos/routes.ts';
import { collectionRoutes } from './photos/collections.ts';
import { filterPresetRoutes } from './photos/filterPresets.ts';
import { trashRoutes } from './photos/trash.ts';
import { uploadRoutes } from './photos/uploads.ts';
import { tagRoutes } from './photos/tags.ts';
import { receiveRoutes } from './transfer/receive.ts';
import { TransferRunner, sendRoutes } from './transfer/send.ts';
import { tokenRoutes } from './transfer/tokens.ts';
import { presetRoutes } from './presets/routes.ts';
import { RenderQueue } from './render/queue.ts';
import { ZoomRenderer } from './render/zoom.ts';
import { keepAssets } from './webAssets.ts';

export async function buildApp() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: 2 * 1024 * 1024,
    // Behind a proxy (Caddy in `deploy/`): the client's address from X-Forwarded-For.
    trustProxy: config.trustProxy,
  });
  const renderQueue = new RenderQueue(app.log);
  const zoom = new ZoomRenderer(app.log);

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: 'Invalid request', issues: error.issues });
    }
    const status = error.statusCode ?? 500;
    if (status >= 500) request.log.error({ err: error }, 'request failed');
    return reply.code(status).send({ error: status >= 500 ? 'Internal server error' : error.message });
  });

  // Cookies are SameSite=Lax; additionally refuse cross-origin state-changing requests.
  // (X-Forwarded-Host is set by the dev proxy; a cross-site page cannot set it without
  // a CORS preflight, which this server never grants.)
  app.addHook('onRequest', async (request, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    const origin = request.headers.origin;
    const hosts = [request.headers.host, request.headers['x-forwarded-host']].flat();
    if (origin && !hosts.includes(new URL(origin).host)) {
      return reply.code(403).send({ error: 'Cross-origin request refused' });
    }
  });

  // Before any route: it's applied to routes as they're added.
  await rateLimits(app);
  // Not encapsulated: its headers must go on every response, static files included.
  await isolationReports(app);
  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, { limits: { fileSize: config.maxUploadBytes, files: 500 } });
  await app.register(authPlugin);
  await app.register(authRoutes);
  await app.register(photoRoutes, { renderQueue, zoom });
  await app.register(trashRoutes);
  await app.register(uploadRoutes, { renderQueue });
  await app.register(tagRoutes);
  await app.register(collectionRoutes);
  const transfers = new TransferRunner(app.log);
  await app.register(tokenRoutes);
  await app.register(receiveRoutes, { renderQueue });
  await app.register(sendRoutes, { runner: transfers });
  await app.register(presetRoutes);
  await app.register(filterPresetRoutes);
  await app.register(exportRoutes);
  await app.register(lutRoutes, { renderQueue });
  await app.register(denoiseRoutes);
  await app.register(accountRoutes, { renderQueue });

  app.get('/api/health', async () => ({ ok: true }));

  // In production, serve the built web app (with client-side routing fallback).
  if (existsSync(config.webDistDir)) {
    // Its files, from this build and the ones before (see `webAssets.ts`).
    const assetsDir = path.join(config.storageDir, 'web-assets');
    const kept = await keepAssets(path.join(config.webDistDir, 'assets'), assetsDir);
    app.log.info(kept, 'web assets');
    await app.register(fastifyStatic, {
      root: assetsDir,
      prefix: '/assets/',
      // Named by a hash of their content: kept without asking again. index.html (sent
      // from the build, below) is checked every time, so a deploy shows on the next load.
      cacheControl: false,
      setHeaders: (reply, file) =>
        reply.header(
          'cache-control',
          path.dirname(file) === assetsDir ? 'public, max-age=31536000, immutable' : 'no-cache',
        ),
    });
    app.setNotFoundHandler((request, reply) => {
      // Not index.html for a file that isn't there (asked for by a page from a build gone
      // for KEEP_DAYS): a 404 fails clearly.
      if (request.method === 'GET' && !request.url.startsWith('/api/') && !request.url.startsWith('/assets/')) {
        return reply.sendFile('index.html', config.webDistDir);
      }
      return reply.code(404).send({ error: 'Not found' });
    });
  }

  app.addHook('onClose', async () => {
    await Promise.all([renderQueue.stop(), zoom.stop()]);
  });

  return { app, renderQueue, transfers };
}
