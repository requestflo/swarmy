import { z } from 'zod';

/**
 * Who signed the image a part runs, per running digest (the app canvas's sign
 * chip). Browser-safe: the controller answers with these facts, the dashboard
 * says them in plain words.
 *
 * - `swarmy`: signed with the org's cosign key, the one swarmy made and signs
 *   every build with;
 * - `trusted`: signed with a key the org added to its trusted keys;
 * - `unsigned`: checked, and no key swarmy trusts signed it;
 * - `unchecked`: swarmy has no answer for this digest. Never a guess.
 */
export const SIGN_STATES = ['swarmy', 'trusted', 'unsigned', 'unchecked'] as const;
export type SignState = (typeof SIGN_STATES)[number];

/** Why a part reads "not checked". */
export const SIGN_UNCHECKED_WHY = ['not-pinned', 'third-party', 'never-checked'] as const;
export type SignUncheckedWhy = (typeof SIGN_UNCHECKED_WHY)[number];

/** Where a verdict came from: admission's verify at deploy, or swarmy's build signing it. */
export type SignSource = 'admission' | 'build';

/** One part of an app and the signature on the image it runs. */
export interface ImageSignatureView {
  /** Full service name. */
  service: string;
  /** The image ref it runs (as Docker resolved it). */
  image: string;
  /** `sha256:…` of the running image; null when Docker did not pin one. */
  digest: string | null;
  state: SignState;
  /** Only for `unchecked`. */
  why?: SignUncheckedWhy;
  /** The trusted key's name, for `trusted`. */
  keyName?: string | null;
  source?: SignSource;
  /** When the verdict was recorded (ISO). */
  checkedAt?: string;
}

/** A key the org trusts, as the dashboard sees it (the PEM is public, but the fingerprint is enough). */
export interface TrustedKeyView {
  name: string;
  /** First 16 hex of sha256 over the key's DER bytes. */
  fingerprint: string;
}

export const MAX_TRUSTED_KEYS = 10;

const PEM_RE = /^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\s*$/;

export const TrustedKeyInput = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[^\n\r<>`]+$/, 'name must be one line without < > or `'),
  publicKey: z.string().trim().max(4000).regex(PEM_RE, 'paste a PEM public key (-----BEGIN PUBLIC KEY-----)'),
});
export type TrustedKeyInput = z.infer<typeof TrustedKeyInput>;

export const RemoveTrustedKeyInput = z.object({ name: z.string().trim().min(1).max(40) });
export type RemoveTrustedKeyInput = z.infer<typeof RemoveTrustedKeyInput>;

export const ImageSignaturesInput = z.object({ stack: z.string().min(1).max(200) });
export type ImageSignaturesInput = z.infer<typeof ImageSignaturesInput>;
