import { deleteExpiredSessions } from './auth/sessions.ts';
import { buildApp } from './app.ts';
import { config } from './config.ts';
import { db } from './db.ts';
import { migrate } from './migrate.ts';

if (config.migrateOnStart) await migrate(db);

const { app, renderQueue } = await buildApp();
renderQueue.start();
await renderQueue.enqueuePending();
await deleteExpiredSessions();

await app.listen({ port: config.port, host: config.host });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    await db.dispose();
    process.exit(0);
  });
}
