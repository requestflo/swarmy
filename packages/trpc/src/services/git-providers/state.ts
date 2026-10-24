/**
 * Signed, expiring `state` for provider redirects (GitHub App manifest +
 * setup, GitLab / Gitea OAuth). It binds a round-trip through the provider to the
 * swarmy org + user that started it, so a callback can't be replayed into
 * another org, AND to the browser that started it (`bind`, the hash of a
 * nonce held in a host-only cookie — git-browser-bind.ts), so a link minted
 * by one person can't be finished in someone else's browser (installation
 * hijack). HMAC-SHA256 over base64url JSON; the key is derived from
 * `SWARMY_SECRET_KEY` by the caller (never hard-coded here).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface OAuthState {
  /** What the round-trip is for. */
  purpose: 'github-manifest' | 'github-setup' | 'gitlab-oauth' | 'gitea-oauth';
  orgId: string;
  userId: string;
  /** Extra context (e.g. the GitLab connection id being authorized). */
  ref?: string;
  /** sha256 of the browser nonce (`bindHash`); the callback must present the nonce. */
  bind: string;
  nonce: string;
  /** Unix seconds. */
  exp: number;
}

export const STATE_TTL_SECONDS = 10 * 60;

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** What a state carries for the browser nonce: its sha256, never the nonce itself. */
export function bindHash(browserNonce: string): string {
  return createHash('sha256').update(`swarmy:git-bind:${browserNonce}`).digest('base64url');
}

export function signState(
  key: string,
  s: Omit<OAuthState, 'nonce' | 'exp'>,
  nowSec = Math.floor(Date.now() / 1000),
): string {
  const payload: OAuthState = {
    ...s,
    nonce: randomBytes(12).toString('hex'),
    exp: nowSec + STATE_TTL_SECONDS,
  };
  const body = b64url(JSON.stringify(payload));
  const mac = createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Verify + decode; `null` on a bad MAC, malformed token, wrong purpose,
 * expiry, or when `browserNonce` (the cookie the callback request carried)
 * is missing or isn't the one the state was bound to.
 */
export function verifyState(
  key: string,
  token: string,
  purpose: OAuthState['purpose'],
  browserNonce: string | null | undefined,
  nowSec = Math.floor(Date.now() / 1000),
): OAuthState | null {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const want = createHmac('sha256', key).update(body).digest();
  if (!sameBytes(Buffer.from(mac, 'base64url'), want)) return null;
  let s: OAuthState;
  try {
    s = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OAuthState;
  } catch {
    return null;
  }
  if (s.purpose !== purpose || typeof s.exp !== 'number' || s.exp < nowSec) return null;
  if (typeof s.bind !== 'string' || !browserNonce) return null;
  if (!sameBytes(Buffer.from(bindHash(browserNonce)), Buffer.from(s.bind))) return null;
  return s;
}
