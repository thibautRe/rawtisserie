import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return value;
}

/** S3-compatible object storage, when `S3_BUCKET` is set; local disk otherwise. */
function s3Config() {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) return null;
  return {
    bucket,
    endpoint: process.env.S3_ENDPOINT || undefined,
    region: process.env.S3_REGION || 'us-east-1',
    accessKeyId: required('S3_ACCESS_KEY_ID'),
    secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
    /** `bucket` in the path rather than the host name (some servers only do this). */
    pathStyle: process.env.S3_PATH_STYLE === 'true',
  };
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST ?? '127.0.0.1',
  databaseUrl: required('DATABASE_URL'),
  /** Files on local disk: originals, renders and LUTs without S3, and uploads in progress. */
  storageDir: path.resolve(repoRoot, process.env.STORAGE_DIR ?? 'data'),
  s3: s3Config(),
  webDistDir: path.resolve(repoRoot, 'apps/web/dist'),
  allowSignup: process.env.ALLOW_SIGNUP !== 'false',
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  sessionTtlDays: 30,
  maxUploadBytes: 400 * 1024 * 1024,
  renderConcurrency: Math.max(1, Number(process.env.RENDER_CONCURRENCY ?? 2)),
  migrateOnStart: process.env.MIGRATE_ON_START !== 'false',
};
