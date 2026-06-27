/**
 * Credential vault — one envelope-encryption mechanism shared by every epic that
 * stores secrets (ingress TLS/tunnel creds, git/registry tokens, restic/S3 creds,
 * OIDC client secrets, controller-state backups). Keyed by `SWARMY_SECRET_KEY`.
 *
 * Rules (see plans/ROADMAP.md → credential handling): hash-or-encrypt at rest,
 * never return secrets to the client, the wire carries references resolved at
 * dispatch — not persisted plaintext.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

const KEY_CONTEXT = 'swarmy.vault.v1';

function deriveKey(): Buffer {
  const secret = process.env.SWARMY_SECRET_KEY;
  if (!secret) {
    throw new Error('SWARMY_SECRET_KEY is not set — required to encrypt/decrypt secrets');
  }
  return scryptSync(secret, KEY_CONTEXT, 32);
}

export function isVaultConfigured(): boolean {
  return Boolean(process.env.SWARMY_SECRET_KEY);
}

/** Encrypt a plaintext secret into a self-describing `v1.iv.tag.ciphertext` blob. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    'v1',
    iv.toString('base64url'),
    tag.toString('base64url'),
    ct.toString('base64url'),
  ].join('.');
}

/** Decrypt a blob produced by {@link encryptSecret}. */
export function decryptSecret(blob: string): string {
  const [version, ivB64, tagB64, ctB64] = blob.split('.');
  if (version !== 'v1' || !ivB64 || !tagB64 || !ctB64) {
    throw new Error('unrecognized secret blob format');
  }
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(), Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/** SHA-256 hex digest — for hashing tokens we only ever compare, never recover. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time compare of a presented token against a stored sha-256 hash. */
export function verifyTokenHash(token: string, storedHash: string): boolean {
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Generate a random opaque token, e.g. `swt_…`, `swk_…` (API key), `swb_…`. */
export function randomToken(prefix = 'swt'): string {
  return `${prefix}_${randomBytes(24).toString('base64url')}`;
}
