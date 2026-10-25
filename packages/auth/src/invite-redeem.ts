import { randomUUID } from 'node:crypto';
import type { DB } from '@swarmy/db';
import { displayEmail, isLinkInviteEmail } from './identity';
import type { AuthAudit } from './provisioning';
import { inviteAdmits } from './signup-policy';
import { checkSsoInvite, inviteNeedsSso, type InviteSsoRefusal } from './sso-invites';

export type RedeemDb = Pick<DB, 'member' | 'invitation'> &
  Partial<Pick<DB, 'ssoProvider' | 'account' | 'orgSecurityPolicy'>>;

export type RedeemResult =
  | {
      ok: true;
      orgId: string;
      role: string;
      /** The member row the invitee now has (new, or the one they already had). */
      memberId: string;
      /** False when they were already a member (nothing about them changed). */
      created: boolean;
      /** The app the invite scopes them to (`Invitation.stackName`), if any. */
      stackName: string | null;
    }
  | { ok: false; reason: 'gone' | 'email_mismatch'; invitedEmail?: string }
  | { ok: false; reason: 'sso_required'; sso: InviteSsoRefusal; invitedEmail?: string };

/**
 * Host-injected: give a newly joined member the `operator` grant on the app
 * their invite names (apps/api wires the controller's grant writer, which
 * resolves the app's grant id from swarm config). Best-effort.
 */
export type InviteAppGrant = (
  orgId: string,
  grant: { memberId: string; userId: string; stackName: string; invitationId: string },
) => Promise<void>;

interface Redeemer {
  id: string;
  email: string;
  emailVerified?: boolean | null;
}

/** May this person redeem it? An SSO invite asks the session; any other asks the address. */
async function admits(
  db: RedeemDb,
  inv: { organizationId: string; email: string; requireSso?: boolean | null },
  user: Redeemer,
  signInMethod: string | null | undefined,
): Promise<true | InviteSsoRefusal | 'email_mismatch'> {
  if (await inviteNeedsSso(db, { requireSso: inv.requireSso, orgId: inv.organizationId })) {
    const d = await checkSsoInvite(db, { email: inv.email, orgId: inv.organizationId }, { signInMethod, email: user.email });
    return d.ok ? true : d.reason;
  }
  if (inviteAdmits(inv.email, { email: user.email, emailVerified: Boolean(user.emailVerified) })) return true;
  if (!db.account || !db.ssoProvider) return 'email_mismatch';
  // Not verified: only an identity from one of the INVITING org's own SSO
  // providers counts as proof. Any other IdP (social, another org's SSO) had
  // its chance to assert the address verified — which sets emailVerified.
  const ids = (await db.ssoProvider.findMany({ where: { orgId: inv.organizationId }, select: { providerId: true } })).map(
    (p) => p.providerId,
  );
  const idp = ids.length
    ? await db.account.findFirst({ where: { userId: user.id, providerId: { in: ids } }, select: { id: true } })
    : null;
  const ok = inviteAdmits(inv.email, { email: user.email, idpOrgId: idp ? inv.organizationId : null }, inv.organizationId);
  return ok ? true : 'email_mismatch';
}

/**
 * Redeem a pending, unexpired invitation (single-use). A link-only invite
 * admits whoever holds it; an invite naming an email admits only an account
 * with that address, verified, or carried by an SSO provider of the inviting
 * org ({@link inviteAdmits}). One that must be accepted with SSO
 * (sso-invites.ts) admits only a session signed in through the inviting org's
 * own SSO (`signInMethod`), by that address or the provider's domain. The
 * pending → accepted flip is a conditional update, so two redemptions of one
 * link can't both succeed. Never demotes a member.
 */
export async function redeemInvitation(
  db: RedeemDb,
  input: { invitationId: string; user: Redeemer; signInMethod?: string | null },
  audit?: AuthAudit,
  now: Date = new Date(),
): Promise<RedeemResult> {
  const inv = await db.invitation.findFirst({
    where: { id: input.invitationId, status: 'pending', expiresAt: { gt: now } },
    select: { id: true, organizationId: true, role: true, email: true, stackName: true, requireSso: true },
  });
  if (!inv) return { ok: false, reason: 'gone' };
  const userId = input.user.id;
  const verdict = await admits(db, inv, input.user, input.signInMethod);
  const invitedEmail = displayEmail(inv.email) ?? undefined;
  if (verdict === 'email_mismatch') return { ok: false, reason: 'email_mismatch', invitedEmail };
  if (verdict !== true) return { ok: false, reason: 'sso_required', sso: verdict, invitedEmail };

  const claimed = await db.invitation.updateMany({
    where: { id: inv.id, status: 'pending' },
    data: { status: 'accepted' },
  });
  if (claimed.count === 0) return { ok: false, reason: 'gone' };
  const role = inv.role === 'owner' || inv.role === 'admin' ? inv.role : 'member';
  const existing = await db.member.findFirst({
    where: { organizationId: inv.organizationId, userId },
    select: { id: true },
  });
  const memberId = existing?.id ?? randomUUID();
  if (!existing) {
    await db.member.create({
      data: { id: memberId, organizationId: inv.organizationId, userId, role },
    });
  }
  const stackName = inv.stackName ?? null;
  await audit?.(inv.organizationId, {
    action: 'member.invite.accept',
    targetType: 'invitation',
    targetId: inv.id,
    actorId: userId,
    metadata: {
      role,
      alreadyMember: Boolean(existing),
      kind: isLinkInviteEmail(inv.email) ? 'link' : 'email',
      stackName,
      ...(inv.requireSso ? { requireSso: true, signInMethod: input.signInMethod ?? null } : {}),
    },
  });
  return { ok: true, orgId: inv.organizationId, role, memberId, created: !existing, stackName };
}

/** Whether a redemption should now get its app grant: a NEW member, invited onto one app. */
export function needsAppGrant(res: RedeemResult): res is Extract<RedeemResult, { ok: true }> & { stackName: string } {
  return res.ok && res.created && res.role === 'member' && Boolean(res.stackName);
}
