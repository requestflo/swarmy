import { hashToken } from '@swarmy/core/crypto';
import type { DB } from '@swarmy/db';

/**
 * Shareable invite links (owner decision Q7): multi-use, with a role, an
 * optional app, an expiry and a use count. The token is `swi_<prefix>_<secret>`;
 * only its sha-256 is stored. It rides the same `?invite=` / `swarmy_invite`
 * cookie path as a single-use invitation id, told apart by its prefix, so the
 * sign-up admission check and the login page work for a brand-new person.
 */
export const INVITE_LINK_PREFIX = 'swi';

export function isInviteLinkToken(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.startsWith(`${INVITE_LINK_PREFIX}_`);
}

export interface InviteLinkRow {
  id: string;
  orgId: string;
  role: string;
  stackName: string | null;
  expiresAt: Date | null;
  maxUses: number | null;
  uses: number;
  revokedAt: Date | null;
}

export type InviteLinkState = 'ok' | 'expired' | 'used' | 'revoked';

/** Whether a link can still admit someone new. */
export function inviteLinkState(row: Pick<InviteLinkRow, 'expiresAt' | 'maxUses' | 'uses' | 'revokedAt'>, now: Date = new Date()): InviteLinkState {
  if (row.revokedAt) return 'revoked';
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (row.maxUses !== null && row.uses >= row.maxUses) return 'used';
  return 'ok';
}

export type InviteLinkDb = Partial<Pick<DB, 'inviteLink'>>;

/** The link row for a presented token (any state), or null. */
export async function findInviteLink(db: InviteLinkDb, token: string): Promise<InviteLinkRow | null> {
  if (!db.inviteLink || !isInviteLinkToken(token)) return null;
  return db.inviteLink.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      orgId: true,
      role: true,
      stackName: true,
      expiresAt: true,
      maxUses: true,
      uses: true,
      revokedAt: true,
    },
  });
}

/** Sign-up admission: does this token name a link that still admits people? */
export async function inviteLinkAdmits(db: InviteLinkDb, token: string, now: Date = new Date()): Promise<boolean> {
  const row = await findInviteLink(db, token);
  return Boolean(row && inviteLinkState(row, now) === 'ok');
}
