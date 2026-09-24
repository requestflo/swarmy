/**
 * Email is optional on swarmy (owner decision 2026-09-24): people sign in with
 * SSO, a social account, or a username, and some of them have no email at all.
 *
 * Better Auth's user table still requires a unique `email`, so an account
 * without one gets a PLACEHOLDER address under the reserved `.invalid` TLD
 * (RFC 2606: guaranteed never to resolve or receive mail). Code that would
 * send mail, show an address, or match on one checks {@link isPlaceholderEmail}
 * first. The placeholder is stable per identity so re-sign-in finds the same
 * user:
 *
 *  - `alice@user.swarmy.invalid`: a username account created without email;
 *  - `<sub>@<provider>.sso.swarmy.invalid`: an IdP that returned no email;
 *  - `invite-<token>@invite.swarmy.invalid`: a link-only invitation.
 */

export const PLACEHOLDER_EMAIL_TLD = 'swarmy.invalid';

function localPart(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return (cleaned || 'user').slice(0, 64);
}

function hostPart(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'idp';
}

/** A username account's placeholder address. */
export function usernamePlaceholderEmail(username: string): string {
  return `${localPart(username)}@user.${PLACEHOLDER_EMAIL_TLD}`;
}

/** The placeholder for an IdP account (`sub`) that came back without email. */
export function idpPlaceholderEmail(providerId: string, subject: string): string {
  return `${localPart(subject)}@${hostPart(providerId)}.sso.${PLACEHOLDER_EMAIL_TLD}`;
}

/** A link-only invitation's placeholder address (the invitation is the credential). */
export function invitePlaceholderEmail(token: string): string {
  return `invite-${localPart(token)}@invite.${PLACEHOLDER_EMAIL_TLD}`;
}

export function isPlaceholderEmail(email: string | null | undefined): boolean {
  if (!email) return true;
  return email.toLowerCase().endsWith(`.${PLACEHOLDER_EMAIL_TLD}`);
}

export function isLinkInviteEmail(email: string | null | undefined): boolean {
  return !!email && email.toLowerCase().endsWith(`@invite.${PLACEHOLDER_EMAIL_TLD}`);
}

/** The address to show a human, or null when the account has none. */
export function displayEmail(email: string | null | undefined): string | null {
  return isPlaceholderEmail(email) ? null : (email ?? null);
}

/**
 * The cookie the login page sets while an invite link is open. Holding a valid,
 * pending invitation admits sign-up by ANY method (password, username, social,
 * SSO) on an invite-only controller — the link is the credential.
 */
export const INVITE_COOKIE = 'swarmy_invite';

export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      const v = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(v) || null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Extract SSO group names from an IdP profile claim (array, or a delimited string). */
export function groupsFromClaim(profile: Record<string, unknown>, claim: string): string[] {
  const raw = claimAt(profile, claim);
  const list = Array.isArray(raw)
    ? raw.map((g) => (typeof g === 'string' ? g : typeof g === 'object' && g && 'name' in g ? String((g as { name: unknown }).name) : String(g)))
    : typeof raw === 'string'
      ? raw.split(/[,\s]+/)
      : [];
  // Keycloak emits "/team/sub"; keep the path but drop the leading slash.
  return [...new Set(list.map((g) => g.trim().replace(/^\/+/, '')).filter(Boolean))].slice(0, 200);
}

/** Dotted claim lookup (`realm_access.roles`), also accepting a literal dotted key. */
function claimAt(profile: Record<string, unknown>, claim: string): unknown {
  if (claim in profile) return profile[claim];
  let cur: unknown = profile;
  for (const seg of claim.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * Map IdP group names to swarmy groups. With no map, IdP names pass through.
 * With a map, only mapped names count (an allow-list), each to one or more
 * swarmy groups (comma-separated values).
 */
export function mapGroups(idpGroups: string[], groupMap: Record<string, string> | null | undefined): string[] {
  if (!groupMap || Object.keys(groupMap).length === 0) return idpGroups;
  const out = new Set<string>();
  for (const g of idpGroups) {
    const target = groupMap[g];
    if (!target) continue;
    for (const t of target.split(',')) if (t.trim()) out.add(t.trim());
  }
  return [...out];
}
