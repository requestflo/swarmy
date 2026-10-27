import { INVITE_COOKIE, readCookie } from './identity';

/**
 * The invite the login page parked in the `swarmy_invite` cookie (SameSite=Lax):
 * a single-use invitation id or a shareable `swi_…` link token. It arrives on
 * first-party requests and top-level GETs (the OIDC callback), never on the
 * IdP's cross-site POST to the SAML ACS (saml-invite.ts covers that).
 */

type RequestLike = { headers?: Headers | null; request?: Request | null } | null | undefined;

function cookieHeader(ctx: RequestLike): string | null {
  return ctx?.headers?.get('cookie') ?? ctx?.request?.headers.get('cookie') ?? null;
}

/** The invite id the login page parked in a cookie, if any. */
export function inviteIdFromRequest(ctx: RequestLike): string | null {
  const id = readCookie(cookieHeader(ctx), INVITE_COOKIE);
  return id && /^[\w-]{1,128}$/.test(id) ? id : null;
}
