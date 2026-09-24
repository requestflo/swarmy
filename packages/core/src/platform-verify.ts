/**
 * Offline verification of a signed platform manifest (the swarmy release key).
 *
 * CI signs `platform.json` with a cosign KEY PAIR:
 *
 *   cosign sign-blob --yes --key env://SWARMY_RELEASE_KEY --tlog-upload=false \
 *     --output-signature platform.json.sig platform.json
 *
 * A cosign key-pair signature is a base64 ASN.1/DER ECDSA-P256 signature over
 * SHA-256 of the blob, so the controller checks it with node:crypto against
 * the public key — no cosign binary, no container, no Fulcio/Rekor round-trip:
 * it works on a cluster with no egress at all (the same trust model as
 * `cosign verify-blob --key … --insecure-ignore-tlog`). Ed25519 keys are
 * accepted too (a self-builder signing with openssl).
 *
 * The public key is baked into the controller build ({@link BUILT_IN_RELEASE_PUBKEY});
 * `SWARMY_RELEASE_PUBKEY` (PEM, or a path to a PEM file) overrides it for
 * forks and self-builders. A manifest that fails verification is never used.
 */
import { createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { canonicalManifestJson, parsePlatformManifest, type PlatformManifest } from './platform-manifest';

/**
 * The swarmy release public key (cosign.pub). Empty until the release key pair
 * is generated (`cosign generate-key-pair`, private half + password as the
 * `SWARMY_RELEASE_KEY` / `SWARMY_RELEASE_KEY_PASSWORD` Actions secrets). While
 * empty, every manifest reads as "unverified release" unless the operator sets
 * `SWARMY_RELEASE_PUBKEY`.
 */
export const BUILT_IN_RELEASE_PUBKEY = '';

/** The trusted release key PEM for this controller, or null when none is configured. */
export function releasePublicKey(env: Record<string, string | undefined> = process.env): string | null {
  const v = env.SWARMY_RELEASE_PUBKEY?.trim();
  if (v) {
    if (v.includes('-----BEGIN')) return v;
    if (existsSync(v)) return readFileSync(v, 'utf8');
    return null;
  }
  return BUILT_IN_RELEASE_PUBKEY.trim() || null;
}

export type VerifyResult =
  | { ok: true; manifest: PlatformManifest }
  | { ok: false; reason: string; manifest?: PlatformManifest };

function algFor(key: KeyObject): string | null {
  return key.asymmetricKeyType === 'ed25519' || key.asymmetricKeyType === 'ed448' ? null : 'sha256';
}

function decodeSignature(sig: string): Buffer | null {
  const t = sig.trim();
  if (!t) return null;
  // cosign writes base64; tolerate a raw DER blob read as latin1 as well.
  if (/^[A-Za-z0-9+/=\s]+$/.test(t)) return Buffer.from(t.replace(/\s+/g, ''), 'base64');
  return Buffer.from(t, 'latin1');
}

/**
 * Verify a manifest + detached signature against the release key. `raw` is the
 * manifest as fetched (bytes cosign signed); when it is an object (read back
 * from the DB) its canonical form is checked. Pure except for crypto.
 */
export function verifyPlatformManifest(raw: string | object, signature: string, publicKeyPem: string | null): VerifyResult {
  let manifest: PlatformManifest;
  try {
    manifest = parsePlatformManifest(raw);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  if (!publicKeyPem) return { ok: false, reason: 'no swarmy release key is configured on this controller', manifest };
  let key: KeyObject;
  try {
    key = createPublicKey(publicKeyPem);
  } catch {
    return { ok: false, reason: 'the configured release key is not a valid public key', manifest };
  }
  const sig = decodeSignature(signature);
  if (!sig?.length) return { ok: false, reason: 'the release has no signature', manifest };
  const candidates = new Set<string>();
  if (typeof raw === 'string') candidates.add(raw);
  candidates.add(canonicalManifestJson(manifest));
  for (const data of candidates) {
    try {
      if (cryptoVerify(algFor(key), Buffer.from(data, 'utf8'), key, sig)) return { ok: true, manifest };
    } catch {
      // malformed signature for this key type — try the next candidate
    }
  }
  return { ok: false, reason: 'the signature does not match the swarmy release key', manifest };
}

/**
 * Sign a manifest's canonical bytes with a PEM private key (PKCS#8 / SEC1 EC,
 * or Ed25519). For self-builders and the e2e harness; CI uses cosign, which
 * produces the same signature format. Returns base64.
 */
export function signPlatformManifest(m: PlatformManifest, privateKeyPem: string, passphrase?: string): string {
  const key = createPrivateKey({ key: privateKeyPem, ...(passphrase ? { passphrase } : {}) });
  return cryptoSign(algFor(key), Buffer.from(canonicalManifestJson(m), 'utf8'), key).toString('base64');
}
