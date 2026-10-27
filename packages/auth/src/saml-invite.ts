import type { DB } from '@swarmy/db';
import { inviteIdFromRequest } from './invite-cookie';
import { findInviteLink, inviteLinkState, isInviteLinkToken } from './invite-links';
import { SAML_ACS_PREFIX } from './saml';

/**
 * Invites over SAML, carried server-side. The login page parks the invite in
 * a SameSite=Lax cookie. The sign-in start (`POST /sign-in/sso`, a first-party
 * fetch) carries it, but the IdP's cross-site POST to the ACS doesn't, so a
 * new person on a link invite (no address to match) had nothing to admit them.
 *
 * So the invite rides with the AuthnRequest (saml-request.ts): at the start
 * the invite is checked and its reference is written into the record the SSO
 * plugin stores for InResponseTo correlation. At the ACS that record is
 * consumed once, only for a response whose signed InResponseTo names it, and
 * the reference is handed on in the endpoint context, under a key no client
 * input can set. Sign-up admission (signup-policy.ts) and the sign-in hook
 * (sign-in-invite.ts) read it there and apply the usual invite rules.
 * Nothing the IdP or the browser echoes back (RelayState included) names an
 * invite. The record holds a row id, never a link's token: only its hash is
 * stored (invite-links.ts).
 */

/** A pending invite this sign-in started from: a single-use invitation or a shareable link (by row id). */
export type BoundInvite = { kind: 'invitation' | 'link'; id: string };

/** Where the reference lives: a field of the AuthnRequest record, then a key of the ACS endpoint context. */
export const BOUND_INVITE_KEY = 'swarmyInvite';

export type BindInviteDb = Pick<DB, 'invitation'> & Partial<Pick<DB, 'inviteLink'>>;

export function parseBoundInvite(v: unknown): BoundInvite | null {
  if (!v || typeof v !== 'object') return null;
  const { kind, id } = v as Record<string, unknown>;
  if ((kind !== 'invitation' && kind !== 'link') || typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id)) return null;
  return { kind, id };
}

/** The reference to bind for the invite a sign-in starts from, if that invite can still admit someone. */
export async function bindableInvite(db: BindInviteDb, value: string | null, now: Date = new Date()): Promise<BoundInvite | null> {
  if (!value) return null;
  if (isInviteLinkToken(value)) {
    const row = await findInviteLink(db, value);
    return row && inviteLinkState(row, now) === 'ok' ? { kind: 'link', id: row.id } : null;
  }
  const inv = await db.invitation.findFirst({
    where: { id: value, status: 'pending', expiresAt: { gt: now } },
    select: { id: true },
  });
  return inv ? { kind: 'invitation', id: inv.id } : null;
}

/** The invite bound to this ACS request by saml-request.ts; null on any other path. */
export function boundInviteFrom(ctx: { path?: string } | null | undefined): BoundInvite | null {
  if (!ctx?.path?.startsWith(SAML_ACS_PREFIX)) return null;
  return parseBoundInvite((ctx as Record<string, unknown>)[BOUND_INVITE_KEY]);
}

type InviteCtx = { path?: string; headers?: Headers | null; request?: Request | null } | null | undefined;

/** Sign-up admission's view of the invite: the bound one at the ACS, else the cookie's. */
export function signupInvite(ctx: InviteCtx): { inviteId: string | null; inviteLinkId: string | null } {
  const bound = boundInviteFrom(ctx);
  return {
    inviteId: bound?.kind === 'invitation' ? bound.id : inviteIdFromRequest(ctx),
    inviteLinkId: bound?.kind === 'link' ? bound.id : null,
  };
}
