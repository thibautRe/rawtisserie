import { existsSync } from 'node:fs';
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
import { lutRoutes } from './luts/routes.ts';
import { photoRoutes } from './photos/routes.ts';
import { trashRoutes } from './photos/trash.ts';
import { presetRoutes } from './presets/routes.ts';
import { RenderQueue } from './render/queue.ts';
import { ZoomRenderer } from './render/zoom.ts';

export async function buildApp() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: 2 * 1024 * 1024,
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

  // Not encapsulated: its headers must go on every response, static files included.
  await isolationReports(app);
  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, { limits: { fileSize: config.maxUploadBytes, files: 500 } });
  await app.register(authPlugin);
  await app.register(authRoutes);
  await app.register(photoRoutes, { renderQueue, zoom });
  await app.register(trashRoutes);
  await app.register(presetRoutes);
  await app.register(exportRoutes);
  await app.register(lutRoutes);
  await app.register(accountRoutes, { renderQueue });

  app.get('/api/health', async () => ({ ok: true }));

  // In production, serve the built web app (with client-side routing fallback).
  if (existsSync(config.webDistDir)) {
    await app.register(fastifyStatic, { root: config.webDistDir, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'Not found' });
    });
  }

  app.addHook('onClose', async () => {
    await Promise.all([renderQueue.stop(), zoom.stop()]);
  });

  return { app, renderQueue };
}
