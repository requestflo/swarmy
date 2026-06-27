/**
 * WireGuard keypair generation (Curve25519). Used by the raw-`wireguard` driver
 * to mint a node's private/public keypair control-plane-side. Kept separate from
 * the pure renderer so tests can inject deterministic keys.
 *
 * WireGuard uses X25519 keys, base64-encoded. Node's `crypto` can generate
 * X25519 keypairs; we extract the 32-byte raw scalars to match `wg`'s format.
 */
import { generateKeyPairSync, createPublicKey, createPrivateKey, type KeyObject } from 'node:crypto';

/** A base64 WireGuard keypair, identical in format to `wg genkey`/`wg pubkey`. */
export interface WireguardKeypair {
  privateKey: string;
  publicKey: string;
}

/** Strip DER/PKCS8 wrapping to the raw 32-byte X25519 key, base64-encoded. */
function rawKeyB64(key: KeyObject, type: 'private' | 'public'): string {
  // X25519 raw keys are the last 32 bytes of the DER export.
  const der = key.export({ type: type === 'private' ? 'pkcs8' : 'spki', format: 'der' });
  const raw = der.subarray(der.length - 32);
  return raw.toString('base64');
}

export function generateWireguardKeypair(): WireguardKeypair {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  return {
    privateKey: rawKeyB64(privateKey, 'private'),
    publicKey: rawKeyB64(publicKey, 'public'),
  };
}

/** Derive the public key from a base64 X25519 private key (for reconciliation). */
export function publicKeyFromPrivate(privateKeyB64: string): string {
  const raw = Buffer.from(privateKeyB64, 'base64');
  // Re-wrap the raw 32-byte scalar into a PKCS8 DER X25519 private key, then let
  // Node compute the matching public point.
  const pkcs8Prefix = Buffer.from('302e020100300506032b656e04220420', 'hex');
  const der = Buffer.concat([pkcs8Prefix, raw]);
  const privateKeyObj = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const publicKeyObj = (createPublicKey as unknown as (k: KeyObject) => KeyObject)(privateKeyObj);
  return rawKeyB64(publicKeyObj, 'public');
}
