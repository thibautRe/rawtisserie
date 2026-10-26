import { applyMigrations } from '@databases/pg-migrations';
import type { ConnectionPool } from '@databases/pg';
import { fileURLToPath } from 'node:url';

const migrationsDirectory = fileURLToPath(new URL('../migrations', import.meta.url));

export async function migrate(connection: ConnectionPool): Promise<void> {
  await applyMigrations({ connection, migrationsDirectory });
}
