/**
 * Pure core of the per-digest signing record (the app canvas's sign chip):
 * which digest a part runs, which keys a verify tries and in what order, and
 * the view for one part given the newest recorded verdict. No IO.
 */
import { createHash } from 'node:crypto';
import type { ImageSignatureView, InvService, SignSource } from '@swarmy/core';

/** A verdict worth recording: what cosign actually answered. */
export type SignVerdict = 'swarmy' | 'trusted' | 'unsigned';
const VERDICTS = new Set<string>(['swarmy', 'trusted', 'unsigned']);

/** One recorded answer (an `ImageSignatureCheck` row). */
export interface SignatureCheckRow {
  digest: string;
  verdict: string;
  keyName: string | null;
  source: string;
  checkedAt: Date;
}

/** `repo:tag@sha256:x` → `sha256:x`; null for a ref Docker did not pin. */
export function pinnedDigest(ref: string): string | null {
  const at = ref.lastIndexOf('@');
  const d = at >= 0 ? ref.slice(at + 1) : '';
  return /^sha256:[0-9a-f]{6,64}$/.test(d) ? d : null;
}

/**
 * The image a part runs: the service spec's pinned ref (Docker resolves tags
 * to `@sha256:` at deploy), else a running container's, else the plain ref
 * with no digest.
 */
export function runningImage(s: Pick<InvService, 'image' | 'containers'>): { image: string; digest: string | null } {
  const own = pinnedDigest(s.image);
  if (own) return { image: s.image, digest: own };
  for (const c of s.containers) {
    const d = c.state === 'running' ? pinnedDigest(c.image) : null;
    if (d) return { image: c.image, digest: d };
  }
  return { image: s.image, digest: null };
}

export interface VerifyKey {
  verdict: Exclude<SignVerdict, 'unsigned'>;
  name: string | null;
  publicKey: string;
}

/** The org's own key first, then each trusted key in the order the org listed them. */
export function verifyOrder(cfg: { cosignPublicKey?: string | null; trustedKeys?: { name: string; publicKey: string }[] } | null): VerifyKey[] {
  const keys: VerifyKey[] = [];
  if (cfg?.cosignPublicKey) keys.push({ verdict: 'swarmy', name: null, publicKey: cfg.cosignPublicKey });
  for (const k of cfg?.trustedKeys ?? []) keys.push({ verdict: 'trusted', name: k.name, publicKey: k.publicKey });
  return keys;
}

/** First 16 hex of sha256 over the key's DER bytes (what `openssl pkey -pubin -outform der | sha256sum` starts with). */
export function keyFingerprint(pem: string): string {
  const b64 = pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '').replace(/\s+/g, '');
  return createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex').slice(0, 16);
}

/**
 * One part's sign chip. Order of reasons: an image from another registry is
 * never checked (admission only verifies the org's own registry); an
 * unpinned ref has nothing fixed to check; no recorded answer stays "not
 * checked". Otherwise the newest verdict for the digest.
 */
export function signatureView(input: {
  service: string;
  image: string;
  digest: string | null;
  orgImage: boolean;
  newest: SignatureCheckRow | null;
}): ImageSignatureView {
  const base = { service: input.service, image: input.image, digest: input.digest };
  if (!input.orgImage) return { ...base, state: 'unchecked', why: 'third-party' };
  if (!input.digest) return { ...base, state: 'unchecked', why: 'not-pinned' };
  const row = input.newest;
  if (!row || row.digest !== input.digest || !VERDICTS.has(row.verdict)) return { ...base, state: 'unchecked', why: 'never-checked' };
  const verdict = row.verdict as SignVerdict;
  const source: SignSource = row.source === 'build' ? 'build' : 'admission';
  return {
    ...base,
    state: verdict,
    keyName: verdict === 'trusted' ? row.keyName : null,
    source,
    checkedAt: row.checkedAt.toISOString(),
  };
}
