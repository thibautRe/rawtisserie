import createConnectionPool, { sql, type ConnectionPool } from '@databases/pg';
import tables from '@databases/pg-typed';
import type DatabaseSchema from './__generated__/index.ts';
import databaseSchema from './__generated__/schema.json' with { type: 'json' };
import { config } from './config.ts';

export { sql };

let pool: ConnectionPool | undefined;

/**
 * The connection pool, created on first use: importing this module (as tested modules
 * do, through others) needs no `DATABASE_URL`.
 */
export const db: ConnectionPool = new Proxy({} as ConnectionPool, {
  get(_, key) {
    pool ??= createConnectionPool({ connectionString: config.databaseUrl, bigIntMode: 'number' });
    const value: unknown = Reflect.get(pool, key, pool);
    // Methods are bound to the pool; its own properties (`sql`, a tag with helpers) aren't.
    return typeof value === 'function' && !Object.hasOwn(pool, key) ? value.bind(pool) : value;
  },
});

export const {
  users,
  sessions,
  photos,
  versions,
  history_entries: historyEntries,
  presets,
  export_presets: exportPresets,
  uploads,
} = tables<DatabaseSchema>({ databaseSchema });
