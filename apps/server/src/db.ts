import createConnectionPool, { sql, type ConnectionPool } from '@databases/pg';
import tables from '@databases/pg-typed';
import type DatabaseSchema from './__generated__/index.ts';
import databaseSchema from './__generated__/schema.json' with { type: 'json' };
import { config } from './config.ts';

export { sql };

let pool: ConnectionPool | undefined;

/**
 * A query that gets no answer fails after this long, and its connection is dropped
 * (`@databases` discards a connection after an error that isn't SQL's). Without it, a
 * connection whose socket died silently (the database's host slept, as Docker does
 * with a laptop) stays checked out for ever: a few of those and every request waits
 * for a connection the pool never gets back.
 */
const QUERY_TIMEOUT_MS = 60_000;

/**
 * The connection pool, created on first use: importing this module (as tested modules
 * do, through others) needs no `DATABASE_URL`.
 */
export const db: ConnectionPool = new Proxy({} as ConnectionPool, {
  get(_, key) {
    pool ??= createConnectionPool({
      connectionString: config.databaseUrl,
      bigIntMode: 'number',
      queryTimeoutMilliseconds: QUERY_TIMEOUT_MS,
      // Probes idle connections, so dead ones are found before a query is sent on them.
      keepAlive: true,
      keepAliveInitialDelayMilliseconds: 10_000,
    });
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
