/**
 * Key material + token formats for "Protect my app" (dev-platform §2A).
 *
 * Nothing is stored: every key is DERIVED from `SWARMY_SECRET_KEY` (HKDF), so
 * the controller needs no table, a restore brings the same keys back, and a
 * secret-key rotation rotates them all.
 *
 *   - Identity JWT (EdDSA / Ed25519): what the upstream app receives in
 *     `X-Swarmy-Jwt`, 5-minute lifetime, `aud` = the app host. Public half
 *     served as a JWKS (`/.well-known/swarmy-jwks.json`).
 *   - App cookie + one-time login code (HMAC-SHA256): compact
 *     `<payload>.<mac>`; the cookie is host-bound and only ever REFERENCES the
 *     swarmy Better Auth session (revoking the session revokes app access).
 */
import { createHash, createHmac, createPrivateKey, createPublicKey, hkdfSync, sign, timingSafeEqual, type KeyObject } from 'node:crypto';

function secretKey(): string {
  const secret = process.env.SWARMY_SECRET_KEY;
  if (!secret) throw new Error('SWARMY_SECRET_KEY is not set — required for app login');
  return secret;
}

function derive(info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secretKey(), 'swarmy.app-access', info, 32));
}

const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

// PKCS#8 wrapper for a raw 32-byte Ed25519 seed (RFC 8410).
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

interface SigningKey {
  secret: string;
  privateKey: KeyObject;
  jwk: { kty: 'OKP'; crv: 'Ed25519'; x: string; kid: string; alg: 'EdDSA'; use: 'sig' };
}
let cached: SigningKey | null = null;

/** The controller's app-identity signing key (derived, memoised per secret). */
export function appSigningKey(): SigningKey {
  const secret = secretKey();
  if (cached && cached.secret === secret) return cached;
  const seed = derive('jwt-ed25519-v1');
  const privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const pub = createPublicKey(privateKey).export({ format: 'jwk' }) as { x: string };
  const kid = createHash('sha256').update(pub.x).digest('base64url').slice(0, 16);
  cached = { secret, privateKey, jwk: { kty: 'OKP', crv: 'Ed25519', x: pub.x, kid, alg: 'EdDSA', use: 'sig' } };
  return cached;
}

/** The public JWKS apps verify `X-Swarmy-Jwt` against. */
export function appJwks(): { keys: SigningKey['jwk'][] } {
  return { keys: [appSigningKey().jwk] };
}

export const APP_JWT_TTL_SECONDS = 300;

export interface AppJwtClaims {
  iss: string;
  sub: string;
  aud: string;
  email: string | null;
  name: string | null;
  groups: string[];
  org: string;
  stack: string;
  iat: number;
  exp: number;
}

/** Sign an identity JWT for one app host. */
export function signAppJwt(claims: Omit<AppJwtClaims, 'iat' | 'exp'>, nowMs = Date.now()): string {
  const key = appSigningKey();
  const iat = Math.floor(nowMs / 1000);
  const header = b64u(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: key.jwk.kid }));
  const payload = b64u(JSON.stringify({ ...claims, iat, exp: iat + APP_JWT_TTL_SECONDS }));
  const sig = sign(null, Buffer.from(`${header}.${payload}`), key.privateKey);
  return `${header}.${payload}.${b64u(sig)}`;
}

// ── HMAC tokens (cookie + login code) ────────────────────────────────────────

type TokenKind = 'cookie' | 'code';

function mac(kind: TokenKind, body: string): Buffer {
  return createHmac('sha256', derive(`hmac-${kind}-v1`)).update(body).digest();
}

/** `<b64url(json)>.<b64url(hmac)>`, keyed per kind so a code can never pass as a cookie. */
export function sealToken(kind: TokenKind, payload: Record<string, unknown>): string {
  const body = b64u(JSON.stringify(payload));
  return `${body}.${b64u(mac(kind, body))}`;
}

/** Verify + decode a sealed token; null when forged, malformed or expired (`exp` in seconds). */
export function openToken<T extends { exp: number }>(kind: TokenKind, token: string | undefined, nowMs = Date.now()): T | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
  const body = token.slice(0, dot);
  let given: Buffer;
  try {
    given = Buffer.from(token.slice(dot + 1), 'base64url');
  } catch {
    return null;
  }
  const want = mac(kind, body);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  let payload: T;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number' || payload.exp * 1000 <= nowMs) return null;
  return payload;
}

/** The app-domain cookie: references the swarmy session, bound to one host + org. */
export interface AppCookie {
  v: 1;
  sid: string;
  uid: string;
  host: string;
  org: string;
  exp: number;
}

/** The one-time login code handed from the controller domain to the app domain. */
export interface AppLoginCode {
  v: 1;
  sid: string;
  uid: string;
  host: string;
  org: string;
  /** Path + query to land on after the cookie is set (always same-host, starts with `/`). */
  rd: string;
  nonce: string;
  exp: number;
}
