import { randomUUID } from 'node:crypto';
import type { DB } from '@swarmy/db';
import { inviteLinkState, type InviteLinkRow, type InviteLinkState } from './invite-links';
import type { RedeemResult } from './invite-redeem';
import type { AuthAudit } from './provisioning';
import { checkSsoInvite, inviteNeedsSso, type InviteSsoRefusal } from './sso-invites';

/**
 * Redeeming a shareable invite link (`swi_…`, invite-links.ts) for a signed-in
 * person: the one implementation behind the login page's accept
 * (`authConfig.acceptInvite`) and the SAML ACS, which can't see the invite
 * cookie and redeems the link bound to its AuthnRequest instead (saml-invite.ts).
 *
 * A person already in the org is left as they are and doesn't burn a use. A
 * link that must be accepted with SSO (or any link of an SSO-only org) admits
 * only a session signed in through that org's own provider, at its domain when
 * it names one (sso-invites.ts). The use is claimed with a compare-and-swap
 * that re-checks revoked/expiry, so a link never admits more than `maxUses`
 * people even under concurrent clicks.
 */

export type LinkRedeemDb = Pick<DB, 'member' | 'inviteLink'> & Partial<Pick<DB, 'ssoProvider' | 'orgSecurityPolicy'>>;

export type LinkRefusal = Exclude<InviteLinkState, 'ok'> | 'gone' | 'busy';

export type LinkRedeemResult =
  | Extract<RedeemResult, { ok: true }>
  | { ok: false; reason: LinkRefusal }
  | { ok: false; reason: 'sso_required'; sso: InviteSsoRefusal };

const CLAIM_SELECT = { id: true, orgId: true, role: true, stackName: true, expiresAt: true, maxUses: true, uses: true, revokedAt: true } as const;

/** Claim one use, retrying a few times under contention. */
async function claimUse(db: LinkRedeemDb, row: InviteLinkRow, now: Date): Promise<'ok' | LinkRefusal> {
  let current: InviteLinkRow | null = row;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (!current) return 'gone';
    const state = inviteLinkState(current, now);
    if (state !== 'ok') return state;
    const res = await db.inviteLink.updateMany({
      where: { id: current.id, uses: current.uses, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      data: { uses: current.uses + 1 },
    });
    if (res.count === 1) return 'ok';
    current = await db.inviteLink.findUnique({ where: { id: current.id }, select: CLAIM_SELECT });
  }
  return 'busy';
}

/** Join the link's org with its role. The caller gives the app grant (`needsAppGrant`). */
export async function redeemInviteLink(
  db: LinkRedeemDb,
  input: { link: InviteLinkRow; user: { id: string; email: string }; signInMethod: string | null },
  audit?: AuthAudit,
  now: Date = new Date(),
): Promise<LinkRedeemResult> {
  const { link, user } = input;
  const entry = { action: 'member.inviteLink.accept', targetType: 'inviteLink', targetId: link.id, actorId: user.id };
  const existing = await db.member.findFirst({
    where: { organizationId: link.orgId, userId: user.id },
    select: { id: true, role: true },
  });
  if (existing) {
    await audit?.(link.orgId, { ...entry, metadata: { alreadyMember: true } });
    return { ok: true, orgId: link.orgId, role: existing.role, memberId: existing.id, created: false, stackName: link.stackName };
  }
  if (await inviteNeedsSso(db, { requireSso: link.requireSso, orgId: link.orgId })) {
    const d = await checkSsoInvite(db, { email: null, orgId: link.orgId }, { signInMethod: input.signInMethod, email: user.email });
    if (!d.ok) return { ok: false, reason: 'sso_required', sso: d.reason };
  }
  const claimed = await claimUse(db, link, now);
  if (claimed !== 'ok') return { ok: false, reason: claimed };
  const role = link.role === 'admin' ? 'admin' : 'member';
  const member = await db.member.create({
    data: { id: randomUUID(), organizationId: link.orgId, userId: user.id, role },
    select: { id: true },
  });
  const requireSso = link.requireSso ?? false;
  await audit?.(link.orgId, { ...entry, metadata: { alreadyMember: false, role, stackName: link.stackName, memberId: member.id, requireSso } });
  return { ok: true, orgId: link.orgId, role, memberId: member.id, created: true, stackName: link.stackName };
}
