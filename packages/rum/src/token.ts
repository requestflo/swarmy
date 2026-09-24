import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The app token the edge renders into the RUM tag (`data-app`). It names the
 * app a beacon belongs to and carries the settings the ingest must ENFORCE
 * (mode, replay sample, retention) — signed by the controller, so a browser
 * can neither point its beacons at another org's app nor upgrade a privacy
 * mode app into recording replays.
 *
 *   v1.<base64url(JSON claims)>.<base64url(HMAC-SHA256(key, "rum:" + claims)[0..16])>
 *
 * Settings change ⇒ new claims ⇒ new token (ingress re-renders). The key is
 * derived from SWARMY_SECRET_KEY; nothing is stored.
 */
export interface RumTokenClaims {
  /** Org id. */
  o: string;
  /** App (Docker stack) name. */
  a: string;
  /** Mode: a = analytics (privacy), i = identified. */
  m: 'a' | 'i';
  /** Replay sample rate 0..1 (0 = replay refused at ingest). */
  s: number;
  /** Retention days (stamped on every row → ClickHouse TTL). */
  r: number;
}

const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function mac(secret: string, payload: string): Buffer {
  return createHmac('sha256', secret).update(`rum:${payload}`).digest().subarray(0, 16);
}

export function signRumToken(secret: string, claims: RumTokenClaims): string {
  const payload = b64url(JSON.stringify({ o: claims.o, a: claims.a, m: claims.m, s: claims.s, r: claims.r }));
  return `v1.${payload}.${b64url(mac(secret, payload))}`;
}

const MAX_TOKEN = 512;

/** Verify + decode; null on any tamper, malformed or oversized token. */
export function verifyRumToken(secret: string, token: string | null | undefined): RumTokenClaims | null {
  if (!token || token.length > MAX_TOKEN) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const [, payload, sig] = parts as [string, string, string];
  const want = mac(secret, payload);
  let got: Buffer;
  try {
    got = fromB64url(sig);
  } catch {
    return null;
  }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const c = JSON.parse(fromB64url(payload).toString('utf8')) as Partial<RumTokenClaims>;
    if (typeof c.o !== 'string' || typeof c.a !== 'string') return null;
    if (c.m !== 'a' && c.m !== 'i') return null;
    const s = typeof c.s === 'number' && c.s >= 0 && c.s <= 1 ? c.s : 0;
    const r = typeof c.r === 'number' && c.r >= 1 && c.r <= 365 ? Math.floor(c.r) : 14;
    return { o: c.o, a: c.a, m: c.m, s, r };
  } catch {
    return null;
  }
}
