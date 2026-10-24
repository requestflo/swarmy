/**
 * Browser binding for git provider round-trips (security review M6).
 *
 * Starting a GitHub App / GitLab / Gitea flow sets a short-lived, host-only
 * nonce cookie on the dashboard response and signs only its hash into the
 * provider `state` (git-providers/state.ts). The callback (apps/api
 * git-callback.ts) must come back in the SAME browser carrying that cookie,
 * so a link minted by an attacker and sent to a victim (who installs the App
 * or grants OAuth on their account) can't bind the victim's installation to
 * the attacker's org.
 *
 * The cookie is `__Host-` (Secure, Path=/, no Domain: only this exact host
 * can set or read it) whenever the controller is served over https. A plain
 * http controller (local dev) falls back to a host-only plain cookie, and an
 * https controller never accepts the plain one.
 */
import { randomBytes } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { controllerPublicUrl } from './git-credentials';
import { bindHash, STATE_TTL_SECONDS } from './git-providers/state';

export const GIT_BIND_COOKIE_SECURE = '__Host-swarmy-git-bind';
export const GIT_BIND_COOKIE_PLAIN = 'swarmy-git-bind';

const NONCE_RE = /^[0-9a-f]{64}$/;

/** https controller → the `__Host-` cookie; plain http (dev) → the host-only plain one. */
function secure(): boolean {
  return controllerPublicUrl().startsWith('https://');
}

/** The Set-Cookie for a nonce (also used to refresh it between the manifest and install steps). */
export function gitBindCookie(nonce: string, maxAgeSec = STATE_TTL_SECONDS): string {
  return secure()
    ? `${GIT_BIND_COOKIE_SECURE}=${nonce}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=Lax`
    : `${GIT_BIND_COOKIE_PLAIN}=${nonce}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Lax`;
}

/** Expire the cookie once a flow is finished (either way). */
export function clearGitBindCookie(): string {
  return gitBindCookie('', 0);
}

/** The nonce the callback request carries, or null (absent / malformed / wrong flavour). */
export function gitBindNonce(cookieHeader: string | null | undefined): string | null {
  const name = secure() ? GIT_BIND_COOKIE_SECURE : GIT_BIND_COOKIE_PLAIN;
  for (const part of (cookieHeader ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0 || part.slice(0, eq).trim() !== name) continue;
    const v = part.slice(eq + 1).trim();
    return NONCE_RE.test(v) ? v : null; // first one wins, like the browser's own order
  }
  return null;
}

/**
 * Bind a provider round-trip to the calling browser: set the nonce cookie on
 * this response and return the hash to sign into the state. Refused without
 * an HTTP response to carry the cookie (REST / API keys can't run a browser flow).
 */
export function bindBrowser(ctx: { resHeaders?: Headers }): string {
  if (!ctx.resHeaders) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Connecting a git provider through its sign-in page has to start in the dashboard.',
    });
  }
  const nonce = randomBytes(32).toString('hex');
  ctx.resHeaders.append('set-cookie', gitBindCookie(nonce));
  return bindHash(nonce);
}

/** The plain-words refusal for a callback whose state or browser binding didn't check out. */
export function notStartedHere(provider: string): TRPCError {
  return new TRPCError({
    code: 'UNAUTHORIZED',
    message: `This ${provider} link expired or was not started in this browser — start again from swarmy.`,
  });
}
