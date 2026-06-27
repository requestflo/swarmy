// SPDX-License-Identifier: LicenseRef-swarmy-Enterprise
/**
 * Enterprise license-key gate (first EE-governed module).
 *
 * This is the open-core seam: enterprise features live in the same tree as the
 * community code (see ee/README.md) but are inert unless a valid license key is
 * present in `SWARMY_LICENSE_KEY`. The community build ships this file but never
 * enables EE behaviour because no key is set.
 *
 * THIS IS A STUB. Real verification (signed key, expiry, seat/feature claims,
 * offline grace period) lands with the first enterprise feature. For now we do a
 * shape check only: a key is a non-empty `swk_`-prefixed token. Do not treat the
 * current check as a security boundary — it gates feature availability, not
 * access to secrets.
 *
 * This module is licensed under the swarmy Enterprise License (ee/LICENSE), not
 * the FSL that governs the rest of the controller.
 */

const KEY_PREFIX = 'swk_';

export interface LicenseStatus {
  enabled: boolean;
  /** Present and structurally valid (not necessarily cryptographically valid). */
  hasKey: boolean;
  /** Human-readable reason, useful for the dashboard / `GET /version`. */
  reason: 'no-key' | 'malformed-key' | 'ok';
}

function readKey(): string {
  return (process.env.SWARMY_LICENSE_KEY ?? '').trim();
}

function isWellFormed(key: string): boolean {
  // Stub validation: `swk_` + at least 16 chars of opaque token body.
  return key.startsWith(KEY_PREFIX) && key.length >= KEY_PREFIX.length + 16;
}

/** Full status, for surfacing in introspection endpoints / the dashboard. */
export function licenseStatus(): LicenseStatus {
  const key = readKey();
  if (!key) return { enabled: false, hasKey: false, reason: 'no-key' };
  if (!isWellFormed(key)) return { enabled: false, hasKey: true, reason: 'malformed-key' };
  return { enabled: true, hasKey: true, reason: 'ok' };
}

/**
 * The single gate every enterprise-only code path must check.
 *
 *   import { isEnterpriseEnabled } from './license';
 *   if (isEnterpriseEnabled()) { ...EE path... }
 */
export function isEnterpriseEnabled(): boolean {
  return licenseStatus().enabled;
}
