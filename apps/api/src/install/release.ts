/**
 * The signed release manifest the node installer checks its downloads against
 * (security review H17), served at:
 *
 *   GET /install/release/platform.json      → canonical manifest bytes (what the release key signed)
 *   GET /install/release/platform.json.sig  → the detached signature (base64)
 *
 * The controller does not mint this — CI signs it with the swarmy release key
 * and the controller keeps the copy it fetched from the feed (or imported from
 * an offline bundle) on `PlatformConfig.available`. Only a release for THIS
 * controller's own build is handed out: its `agentBinaries` are then the
 * binaries this controller serves at `/install/bin/<platform>`, and its `agent`
 * component is the agent image of the same build. When the controller holds a
 * release key it serves only a copy that verifies; the installer verifies
 * again on the node (it never trusts the controller's say-so).
 *
 * No match (a dev build, a controller that never checked the feed, an
 * air-gapped install without a bundle) ⇒ 404, and the installer falls back to
 * the checksums the controller pins, with a warning.
 *
 * Pure; unit-tested in release.test.ts.
 */
import { canonicalManifestJson, parsePlatformManifest, type PlatformManifest } from '@swarmy/core/platform-manifest';
import { verifyPlatformManifest } from '@swarmy/core/platform-verify';

export interface StoredRelease {
  manifest?: unknown;
  /** The manifest exactly as signed (QA-070); served verbatim when present. */
  raw?: unknown;
  signature?: unknown;
}

export interface ServedRelease {
  /** The signed manifest bytes (the stored raw copy, else the canonical JSON). */
  body: string;
  signature: string;
  manifest: PlatformManifest;
}

/** Same build: version, and the commit when both sides know it. */
function sameBuild(m: PlatformManifest, build: { version: string; commit: string }): boolean {
  if (m.version !== build.version) return false;
  const known = (c: string) => c && c !== 'dev';
  return !(known(m.commit) && known(build.commit)) || m.commit === build.commit;
}

/**
 * Pick the stored release that describes this controller's build. With a
 * release key configured only a verifying copy is served; without one the
 * signed copy is still served (the node may bring its own key via
 * `SWARMY_RELEASE_PUBKEY`).
 */
export function releaseForBuild(
  stored: readonly (StoredRelease | null | undefined)[],
  build: { version: string; commit: string },
  publicKeyPem: string | null,
): ServedRelease | null {
  for (const s of stored) {
    if (!s?.manifest || typeof s.signature !== 'string' || !s.signature.trim()) continue;
    const raw = typeof s.raw === 'string' && s.raw ? s.raw : null;
    let m: PlatformManifest;
    try {
      m = parsePlatformManifest(raw ?? s.manifest);
    } catch {
      continue;
    }
    if (!sameBuild(m, build)) continue;
    if (publicKeyPem && !verifyPlatformManifest(raw ?? m, s.signature, publicKeyPem).ok) continue;
    return { body: raw ?? canonicalManifestJson(m), signature: s.signature.trim(), manifest: m };
  }
  return null;
}
