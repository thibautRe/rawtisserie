import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST ?? '127.0.0.1',
  databaseUrl: required('DATABASE_URL'),
  storageDir: path.resolve(repoRoot, process.env.STORAGE_DIR ?? 'data'),
  webDistDir: path.resolve(repoRoot, 'apps/web/dist'),
  allowSignup: process.env.ALLOW_SIGNUP !== 'false',
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  sessionTtlDays: 30,
  maxUploadBytes: 400 * 1024 * 1024,
  renderConcurrency: Math.max(1, Number(process.env.RENDER_CONCURRENCY ?? 2)),
  migrateOnStart: process.env.MIGRATE_ON_START !== 'false',
};
