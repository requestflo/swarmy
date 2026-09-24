/**
 * Signed, expiring `state` for provider redirects (GitHub App manifest +
 * setup, GitLab OAuth). It binds a round-trip through the provider to the
 * swarmy org + user that started it, so a callback can't be replayed into
 * another org. HMAC-SHA256 over base64url JSON; the key is derived from
 * `SWARMY_SECRET_KEY` by the caller (never hard-coded here).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface OAuthState {
  /** What the round-trip is for. */
  purpose: 'github-manifest' | 'github-setup' | 'gitlab-oauth';
  orgId: string;
  userId: string;
  /** Extra context (e.g. the GitLab connection id being authorized). */
  ref?: string;
  nonce: string;
  /** Unix seconds. */
  exp: number;
}

export const STATE_TTL_SECONDS = 10 * 60;

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

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

/** Verify + decode; `null` on a bad MAC, malformed token, wrong purpose, or expiry. */
export function verifyState(
  key: string,
  token: string,
  purpose: OAuthState['purpose'],
  nowSec = Math.floor(Date.now() / 1000),
): OAuthState | null {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const want = createHmac('sha256', key).update(body).digest();
  let got: Buffer;
  try {
    got = Buffer.from(mac, 'base64url');
  } catch {
    return null;
  }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const s = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OAuthState;
    if (s.purpose !== purpose || typeof s.exp !== 'number' || s.exp < nowSec) return null;
    return s;
  } catch {
    return null;
  }
}
