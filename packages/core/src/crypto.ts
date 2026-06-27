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

// ── controller-state restore: user-held passphrase envelope ─────────────────
//
// The controller-state backup (data-store epic, P1) is encrypted with a
// *separate, user-held passphrase* — NOT `SWARMY_SECRET_KEY`. This is the root
// of trust for disaster recovery: a restore must work when the controller (and
// thus the vault key) is gone. scrypt stretches the passphrase into a 256-bit
// key; a random per-bundle salt is stored alongside the ciphertext so restore
// needs only the passphrase. AES-256-GCM gives authenticated encryption.

const PASSPHRASE_MAGIC = 'SWARMY-CB1'; // controller-bundle v1
const SCRYPT_N = 1 << 15; // 32768 — interactive-grade cost
const SCRYPT_PARAMS = { N: SCRYPT_N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

function derivePassphraseKey(passphrase: string, salt: Buffer): Buffer {
  if (!passphrase || passphrase.length < 8) {
    throw new Error('restore passphrase must be at least 8 characters');
  }
  return scryptSync(passphrase, salt, 32, SCRYPT_PARAMS);
}

/**
 * Encrypt a controller-state bundle with a user-held passphrase. Output is a
 * self-describing binary frame: `magic | salt(16) | iv(12) | tag(16) | ct`.
 * Decryptable by {@link decryptWithPassphrase} (and, by hand, with restic + the
 * passphrase + this format) — no controller, no vault key required.
 */
export function encryptWithPassphrase(plaintext: Buffer | Uint8Array, passphrase: string): Buffer {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = derivePassphraseKey(passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from(PASSPHRASE_MAGIC, 'utf8'), salt, iv, tag, ct]);
}

/** Decrypt a frame produced by {@link encryptWithPassphrase}. Throws on a wrong passphrase. */
export function decryptWithPassphrase(frame: Buffer | Uint8Array, passphrase: string): Buffer {
  const buf = Buffer.from(frame);
  const magic = Buffer.from(PASSPHRASE_MAGIC, 'utf8');
  if (buf.length < magic.length + 16 + 12 + 16 || !buf.subarray(0, magic.length).equals(magic)) {
    throw new Error('not a swarmy controller-state bundle (bad magic/length)');
  }
  let o = magic.length;
  const salt = buf.subarray(o, (o += 16));
  const iv = buf.subarray(o, (o += 12));
  const tag = buf.subarray(o, (o += 16));
  const ct = buf.subarray(o);
  const key = derivePassphraseKey(passphrase, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new Error('decryption failed — wrong restore passphrase or corrupt bundle');
  }
}

/** A short, non-secret fingerprint of a passphrase, safe to store as a hint. */
export function passphraseFingerprint(passphrase: string): string {
  return createHash('sha256').update(`swarmy.cb.fp:${passphrase}`).digest('hex').slice(0, 12);
}

/** Generate a strong, human-transcribable restore passphrase (recovery card). */
export function generateRestorePassphrase(): string {
  // 5 groups of 4 chars from an unambiguous alphabet → ~95 bits, card-friendly.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(20);
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  return chars.match(/.{1,4}/g)!.join('-');
}
