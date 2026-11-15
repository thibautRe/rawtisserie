import { deleteExpiredSessions } from './auth/sessions.ts';
import { buildApp } from './app.ts';
import { config } from './config.ts';
import { db } from './db.ts';
import { collectLuts } from './luts/storage.ts';
import { migrate } from './migrate.ts';
import { startTrashPurge } from './photos/trash.ts';
import { startUploadSweep } from './photos/uploads.ts';

if (config.migrateOnStart) await migrate(db);

const { app, renderQueue, transfers } = await buildApp();
renderQueue.start();
await renderQueue.enqueuePending();
await deleteExpiredSessions();
await collectLuts(db);
startTrashPurge(app.log);
startUploadSweep(app.log);
// Transfers to other instances that were running when the server stopped.
transfers.kick();

await app.listen({ port: config.port, host: config.host });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    await db.dispose();
    process.exit(0);
  });
}
