/**
 * Grants or revokes admin rights (the /admin page: users' quotas and invitations).
 * The way to make the first admin; admins can then make others from /admin.
 *
 *   npm run user:admin -w @rawtisserie/server -- you@example.com [--revoke]
 *   docker compose exec app node apps/server/src/scripts/user-admin.ts you@example.com
 */
import { db, sql } from '../db.ts';

const args = process.argv.slice(2);
const revoke = args.includes('--revoke');
const email = args.find((a) => !a.startsWith('--'));
if (!email) {
  console.error('Usage: user-admin <email> [--revoke]');
  process.exit(2);
}

const rows = (await db.query(sql`
  UPDATE users SET is_admin = ${!revoke} WHERE lower(email) = lower(${email})
  RETURNING email, display_name`)) as { email: string; display_name: string }[];
await db.dispose();
if (!rows.length) {
  console.error(`No account with the email ${email}`);
  process.exit(1);
}
console.log(`${rows[0]!.display_name} <${rows[0]!.email}> is ${revoke ? 'no longer' : 'now'} an admin.`);
