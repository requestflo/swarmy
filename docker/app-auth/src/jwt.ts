// Vendored from packages/app-auth/src/jwt.ts (this image builds from docker/app-auth alone). Keep in step.
/**
 * Compact-JWS verification over WebCrypto (Bun, Node ≥ 20, Deno, workers) —
 * no dependencies. Supports the algorithms swarmy and Better Auth sign with:
 * EdDSA (Ed25519, the default for both), ES256 and RS256.
 */

export interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  crv?: string;
  x?: string;
  y?: string;
  n?: string;
  e?: string;
}

export interface JwtHeader {
  alg: string;
  kid?: string;
  typ?: string;
}

export interface JwtClaims {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  jti?: string;
  [claim: string]: unknown;
}

export interface VerifyOptions {
  /** Accept only these audiences (any match). Omit to skip the check. */
  audience?: string | string[];
  /** Accept only this issuer. Omit to skip the check. */
  issuer?: string | string[];
  /** Seconds of clock skew tolerated on exp/nbf (default 30). */
  clockToleranceSec?: number;
  /** Current time in ms (tests). */
  now?: number;
}

export class JwtError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'malformed'
      | 'unsupported-alg'
      | 'unknown-key'
      | 'bad-signature'
      | 'expired'
      | 'not-yet-valid'
      | 'bad-audience'
      | 'bad-issuer',
  ) {
    super(message);
    this.name = 'JwtError';
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function base64UrlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function base64UrlEncode(bytes: Uint8Array | string): string {
  const b = typeof bytes === 'string' ? enc.encode(bytes) : bytes;
  let bin = '';
  for (const byte of b) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Split + JSON-decode a compact JWS without verifying it. */
export function decodeJwt(token: string): { header: JwtHeader; claims: JwtClaims; signingInput: string; signature: Uint8Array } {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) throw new JwtError('not a compact JWS', 'malformed');
  const [h, p, s] = parts as [string, string, string];
  let header: JwtHeader;
  let claims: JwtClaims;
  try {
    header = JSON.parse(dec.decode(base64UrlDecode(h))) as JwtHeader;
    claims = JSON.parse(dec.decode(base64UrlDecode(p))) as JwtClaims;
  } catch {
    throw new JwtError('undecodable JWT', 'malformed');
  }
  if (!header || typeof header.alg !== 'string') throw new JwtError('JWT header has no alg', 'malformed');
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) throw new JwtError('JWT claims are not an object', 'malformed');
  return { header, claims, signingInput: `${h}.${p}`, signature: base64UrlDecode(s) };
}

type Algo = { import: AlgorithmIdentifier | EcKeyImportParams | RsaHashedImportParams; verify: AlgorithmIdentifier | EcdsaParams };

function algorithmFor(alg: string, jwk: Jwk): Algo | null {
  switch (alg) {
    case 'EdDSA':
    case 'Ed25519':
      return jwk.kty === 'OKP' && jwk.crv === 'Ed25519' ? { import: { name: 'Ed25519' }, verify: { name: 'Ed25519' } } : null;
    case 'ES256':
      return jwk.kty === 'EC' && jwk.crv === 'P-256'
        ? { import: { name: 'ECDSA', namedCurve: 'P-256' }, verify: { name: 'ECDSA', hash: 'SHA-256' } }
        : null;
    case 'RS256':
      return jwk.kty === 'RSA'
        ? { import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, verify: { name: 'RSASSA-PKCS1-v1_5' } }
        : null;
    default:
      return null;
  }
}

function pickKey(keys: readonly Jwk[], header: JwtHeader): Jwk | undefined {
  if (header.kid) return keys.find((k) => k.kid === header.kid);
  // No kid: only unambiguous when exactly one key could verify this alg.
  const candidates = keys.filter((k) => algorithmFor(header.alg, k));
  return candidates.length === 1 ? candidates[0] : undefined;
}

const asList = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/**
 * Verify a compact JWS against a key set and check its time + audience +
 * issuer claims. Throws {@link JwtError}; returns the claims on success.
 * `alg: none` and any algorithm/key-type mismatch are rejected.
 */
export async function verifyJwt(token: string, keys: readonly Jwk[], opts: VerifyOptions = {}): Promise<JwtClaims> {
  const { header, claims, signingInput, signature } = decodeJwt(token);
  const jwk = pickKey(keys, header);
  if (!jwk) throw new JwtError(`no key for kid ${header.kid ?? '(none)'}`, 'unknown-key');
  if (jwk.alg && jwk.alg !== header.alg) throw new JwtError(`key ${jwk.kid ?? ''} is for ${jwk.alg}`, 'unsupported-alg');
  const algo = algorithmFor(header.alg, jwk);
  if (!algo) throw new JwtError(`unsupported alg ${header.alg}`, 'unsupported-alg');
  const { kid: _kid, alg: _alg, use: _use, ...material } = jwk;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey('jwk', material as JsonWebKey, algo.import, false, ['verify']);
  } catch {
    throw new JwtError('key import failed', 'unknown-key');
  }
  const ok = await crypto.subtle.verify(algo.verify, key, signature as BufferSource, enc.encode(signingInput) as BufferSource);
  if (!ok) throw new JwtError('signature does not verify', 'bad-signature');

  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const skew = opts.clockToleranceSec ?? 30;
  if (typeof claims.exp === 'number' && now - skew >= claims.exp) throw new JwtError('token expired', 'expired');
  if (typeof claims.nbf === 'number' && now + skew < claims.nbf) throw new JwtError('token not yet valid', 'not-yet-valid');
  const wantAud = asList(opts.audience);
  if (wantAud.length > 0 && !asList(claims.aud).some((a) => wantAud.includes(a))) {
    throw new JwtError('audience mismatch', 'bad-audience');
  }
  const wantIss = asList(opts.issuer);
  if (wantIss.length > 0 && !(typeof claims.iss === 'string' && wantIss.includes(claims.iss))) {
    throw new JwtError('issuer mismatch', 'bad-issuer');
  }
  return claims;
}

export interface RemoteJwksOptions {
  fetch?: typeof fetch;
  /** Cache lifetime for a fetched key set (default 5 minutes). */
  cacheMs?: number;
  /** Minimum gap between refetches triggered by an unknown kid (default 30s). */
  cooldownMs?: number;
}

/**
 * A cached remote JWKS. `keys()` serves the cached set; `refresh()` refetches
 * (rate-limited) — used when a token names a kid the cache has not seen, so
 * a key rotation is picked up without waiting out the cache.
 */
export function remoteJwks(url: string, opts: RemoteJwksOptions = {}) {
  const doFetch = opts.fetch ?? fetch;
  const cacheMs = opts.cacheMs ?? 5 * 60_000;
  const cooldownMs = opts.cooldownMs ?? 30_000;
  let cached: { keys: Jwk[]; at: number } | null = null;
  let inflight: Promise<Jwk[]> | null = null;

  async function load(): Promise<Jwk[]> {
    inflight ??= (async () => {
      try {
        const res = await doFetch(url, { headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error(`JWKS ${url} answered ${res.status}`);
        const body = (await res.json()) as { keys?: unknown };
        const keys = Array.isArray(body.keys) ? (body.keys as Jwk[]) : [];
        cached = { keys, at: Date.now() };
        return keys;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  return {
    url,
    async keys(): Promise<Jwk[]> {
      if (cached && Date.now() - cached.at < cacheMs) return cached.keys;
      return load();
    },
    async refresh(): Promise<Jwk[]> {
      if (cached && Date.now() - cached.at < cooldownMs) return cached.keys;
      return load();
    },
  };
}
export type RemoteJwks = ReturnType<typeof remoteJwks>;

/** Verify against a remote key set, refetching once on an unknown kid (key rotation). */
export async function verifyWithJwks(token: string, jwks: RemoteJwks, opts: VerifyOptions = {}): Promise<JwtClaims> {
  try {
    return await verifyJwt(token, await jwks.keys(), opts);
  } catch (e) {
    if (e instanceof JwtError && e.code === 'unknown-key') return verifyJwt(token, await jwks.refresh(), opts);
    throw e;
  }
}
