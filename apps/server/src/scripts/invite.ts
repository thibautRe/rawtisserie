/**
 * Creates an invitation and prints its link path, for when there's no admin yet (a new
 * server is invite-only): sign up with it, then `user-admin.ts` your account.
 *
 *   npm run user:invite -w @rawtisserie/server -- [--uses 1] [--quota-gb 50] [--label "…"]
 *   docker compose exec app node apps/server/src/scripts/invite.ts
 *
 * Without --quota-gb, the accounts it creates have unlimited storage.
 */
import { parseArgs } from 'node:util';
import { GB } from '../accounts/quota.ts';
import { newInvitationCode } from '../accounts/invitations.ts';
import { db, sql } from '../db.ts';

const { values } = parseArgs({
  options: {
    uses: { type: 'string', default: '1' },
    'quota-gb': { type: 'string' },
    label: { type: 'string' },
  },
});
const uses = Number(values.uses);
const quotaGb = values['quota-gb'] === undefined ? null : Number(values['quota-gb']);
if (!Number.isInteger(uses) || uses < 1 || (quotaGb !== null && !(quotaGb >= 0))) {
  console.error('Usage: invite [--uses N] [--quota-gb GB] [--label TEXT]');
  process.exit(2);
}

const code = newInvitationCode();
await db.query(sql`
  INSERT INTO invitations (code, label, max_uses, storage_quota)
  VALUES (${code}, ${values.label ?? null}, ${uses}, ${quotaGb === null ? null : Math.round(quotaGb * GB)})`);
await db.dispose();
console.log(
  `Invitation for ${uses} account${uses === 1 ? '' : 's'}, ${quotaGb === null ? 'unlimited storage' : `${quotaGb} GB each`}:`,
);
console.log(`  /login?invite=${code}`);
