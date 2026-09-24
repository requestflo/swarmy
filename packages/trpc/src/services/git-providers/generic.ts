/**
 * Generic git (any host): HTTPS + PAT, or an SSH deploy key swarmy generates.
 *
 * The deploy key is ed25519. The PUBLIC half (`ssh-ed25519 AAAA… swarmy@<app>`)
 * is shown once for the operator to paste into their host as a read-only deploy
 * key; the PRIVATE half is emitted in the OpenSSH `openssh-key-v1` format git's
 * ssh understands, vault-encrypted at rest, and only ever travels to a Builder
 * inside a one-shot container (never a layer, never a log).
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';

export interface DeployKey {
  publicKey: string;
  privateKey: string;
}

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const sshString = (b: Buffer | string) => {
  const buf = Buffer.isBuffer(b) ? b : Buffer.from(b);
  return Buffer.concat([u32(buf.length), buf]);
};

/** Raw 32-byte keys out of node's JWK export. */
function ed25519Raw(): { pub: Buffer; seed: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubJwk = publicKey.export({ format: 'jwk' }) as { x: string };
  const privJwk = privateKey.export({ format: 'jwk' }) as { d: string };
  return { pub: Buffer.from(pubJwk.x, 'base64url'), seed: Buffer.from(privJwk.d, 'base64url') };
}

export function encodeOpenSshPublic(pub: Buffer, comment: string): string {
  const blob = Buffer.concat([sshString('ssh-ed25519'), sshString(pub)]);
  return `ssh-ed25519 ${blob.toString('base64')} ${comment}`;
}

/** Unencrypted `openssh-key-v1` private key (cipher/kdf "none"). */
export function encodeOpenSshPrivate(
  pub: Buffer,
  seed: Buffer,
  comment: string,
  checkInt = randomBytes(4).readUInt32BE(),
): string {
  const pubBlob = Buffer.concat([sshString('ssh-ed25519'), sshString(pub)]);
  let priv = Buffer.concat([
    u32(checkInt),
    u32(checkInt),
    sshString('ssh-ed25519'),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])), // 64-byte "private" = seed ‖ pub
    sshString(comment),
  ]);
  // Pad to the 8-byte cipher block size with 1,2,3,…
  const pad = (8 - (priv.length % 8)) % 8;
  priv = Buffer.concat([priv, Buffer.from(Array.from({ length: pad }, (_, i) => i + 1))]);
  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0'),
    sshString('none'),
    sshString('none'),
    sshString(''),
    u32(1),
    sshString(pubBlob),
    sshString(priv),
  ]);
  const b64 = body
    .toString('base64')
    .replace(/(.{70})/g, '$1\n')
    .trimEnd();
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

export function generateDeployKey(comment = 'swarmy'): DeployKey {
  const { pub, seed } = ed25519Raw();
  return {
    publicKey: encodeOpenSshPublic(pub, comment),
    privateKey: encodeOpenSshPrivate(pub, seed, comment),
  };
}

/** `git@host:owner/repo.git` / `ssh://…` → true (needs a deploy key, not a token). */
export function isSshGitUrl(url: string): boolean {
  return /^ssh:\/\//.test(url) || /^[\w.-]+@[\w.-]+:/.test(url);
}

/** The host a git URL talks to — for known_hosts scanning and display. */
export function gitHost(url: string): string | null {
  const scp = /^[\w.-]+@([\w.-]+):/.exec(url);
  if (scp?.[1]) return scp[1];
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}
