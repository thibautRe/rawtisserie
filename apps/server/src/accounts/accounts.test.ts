import assert from 'node:assert/strict';
import { test } from 'node:test';
import type Invitations from '../__generated__/invitations.ts';
import { invitationProblem, invitationStatus, newInvitationCode } from './invitations.ts';
import { GB, fits, formatBytes, quotaExceeded } from './quota.ts';

test('uploads fit until the quota is reached; null is unlimited', () => {
  assert.ok(fits({ used: 0, quota: null }, 10 * GB));
  assert.ok(fits({ used: 9 * GB, quota: 10 * GB }, GB));
  assert.ok(!fits({ used: 9 * GB, quota: 10 * GB }, GB + 1));
  // A quota lowered below what's stored blocks uploads, and deletes nothing.
  assert.ok(!fits({ used: 12 * GB, quota: 10 * GB }, 1));
  assert.equal(quotaExceeded({ used: 9.5 * GB, quota: 10 * GB }), 'Not enough storage: 9.5 GB of 10.0 GB used');
  assert.equal(formatBytes(1.5 * 1024 * GB), '1.5 TB');
});

const invitation = (patch: Partial<Invitations>): Invitations => ({
  id: 'i',
  code: newInvitationCode(),
  label: null,
  max_uses: 3,
  uses: 0,
  storage_quota: 50 * GB,
  expires_at: null,
  revoked_at: null,
  created_by: null,
  created_at: new Date(),
  ...patch,
});

test('an invitation is active until used up, expired or revoked', () => {
  const now = new Date('2026-11-13T12:00:00Z');
  assert.equal(invitationStatus(invitation({}), now), 'active');
  assert.equal(invitationStatus(invitation({ uses: 2 }), now), 'active');
  assert.equal(invitationStatus(invitation({ uses: 3 }), now), 'used');
  assert.equal(invitationStatus(invitation({ expires_at: new Date('2026-11-13T11:59:59Z') }), now), 'expired');
  assert.equal(invitationStatus(invitation({ expires_at: new Date('2026-11-14T00:00:00Z') }), now), 'active');
  // Revoked wins over everything else.
  assert.equal(invitationStatus(invitation({ uses: 3, revoked_at: now }), now), 'revoked');
  assert.equal(invitationProblem(null), 'This invitation link isn’t valid');
  assert.equal(invitationProblem(invitation({})), null);
});

test('invitation codes are long and URL-safe', () => {
  const code = newInvitationCode();
  assert.match(code, /^[A-Za-z0-9_-]{24}$/);
  assert.notEqual(code, newInvitationCode());
});
