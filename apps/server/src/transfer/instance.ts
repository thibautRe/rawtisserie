import { db, sql } from '../db.ts';

let id: Promise<string> | null = null;

/** This instance's id: what its copies elsewhere say they came from. */
export function instanceId(): Promise<string> {
  id ??= db.query(sql`SELECT id FROM instance`).then((rows) => (rows[0] as { id: string }).id);
  return id;
}
