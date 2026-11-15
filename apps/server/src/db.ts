import createConnectionPool, { sql } from '@databases/pg';
import tables from '@databases/pg-typed';
import type DatabaseSchema from './__generated__/index.ts';
import databaseSchema from './__generated__/schema.json' with { type: 'json' };
import { config } from './config.ts';

export { sql };

export const db = createConnectionPool({
  connectionString: config.databaseUrl,
  bigIntMode: 'number',
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
