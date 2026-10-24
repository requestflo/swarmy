// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The controller's local NetBird client mirror (plans/
 * epic-self-hosted-mesh-and-fleets.md §3.4, M3): the desktop installers baked
 * into the controller image at /app/netbird-clients by
 * scripts/fetch-netbird-clients.ts (`SWARMY_NETBIRD_CLIENT_DIR` overrides),
 * served at `/install/netbird/<file>` like the agent binaries.
 *
 * The manifest is trusted only where it matches the sha256 pins in
 * `@swarmy/mesh` (`parseClientMirrorManifest`); a missing directory (dev, an
 * opted-out build, no egress at build time) degrades to upstream links.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  NETBIRD_CLIENT_DOWNLOADS,
  clientDownloads,
  parseClientMirrorManifest,
  servableClientFile,
  type ClientDownloadLink,
  type ClientMirrorManifest,
} from '@swarmy/mesh';

const MANIFEST_TTL_MS = 30_000;
let cached: { manifest: ClientMirrorManifest | null; dir: string; at: number } | null = null;

export function netbirdClientDir(env: Record<string, string | undefined> = process.env): string {
  if (env.SWARMY_NETBIRD_CLIENT_DIR) return env.SWARMY_NETBIRD_CLIENT_DIR;
  // Repo root from packages/trpc/src/services/ (dev: `bun run scripts/fetch-netbird-clients.ts netbird-clients`).
  return path.join(path.resolve(import.meta.dir, '../../../..'), 'netbird-clients');
}

/** The mirrored files this controller can serve, or null when it has none. */
export function netbirdClientMirror(): ClientMirrorManifest | null {
  const dir = netbirdClientDir();
  const now = Date.now();
  if (cached && cached.dir === dir && now - cached.at < MANIFEST_TTL_MS) return cached.manifest;
  let manifest: ClientMirrorManifest | null = null;
  try {
    manifest = parseClientMirrorManifest(JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')));
    if (manifest && Object.keys(manifest.files).length === 0) manifest = null;
  } catch {
    manifest = null;
  }
  cached = { manifest, dir, at: now };
  return manifest;
}

/** Absolute path of a mirrored installer: an exact listed name, in the manifest, on disk. */
export function netbirdClientFilePath(file: string): string | null {
  const asset = servableClientFile(file);
  if (!asset || !netbirdClientMirror()?.files[asset.file]) return null;
  const p = path.join(netbirdClientDir(), asset.file);
  return existsSync(p) ? p : null;
}

/** The mirrored Linux/macOS files (what `/install/netbird.sh` can install), in pin order. */
export function mirroredCliAssets(manifest: ClientMirrorManifest | null = netbirdClientMirror()): { platform: string; file: string; sha256: string }[] {
  return NETBIRD_CLIENT_DOWNLOADS.filter((a) => /^(linux|macos)-/.test(a.platform) && manifest?.files[a.file]).map((a) => ({
    platform: a.platform,
    file: a.file,
    sha256: a.sha256,
  }));
}

/**
 * The controller base the browser downloads from, or null when the install
 * surface would refuse a plain-HTTP download anyway (H17: HTTPS only unless
 * the operator opted in) — then every link is upstream. Pure.
 */
export function mirrorBaseFor(publicUrl: string, env: Record<string, string | undefined> = process.env): string | null {
  const base = publicUrl.replace(/\/+$/, '');
  if (base.startsWith('https://')) return base;
  const v = env.SWARMY_ALLOW_INSECURE_INSTALL?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' ? base : null;
}

/** "Connect from your laptop" step 1: this controller's copies where it has them. */
export function connectDownloads(publicUrl: string): ClientDownloadLink[] {
  const base = mirrorBaseFor(publicUrl);
  return clientDownloads(base ? netbirdClientMirror() : null, base ?? publicUrl);
}

/** The Linux/macOS one-liner (`/install/netbird.sh`), when this controller can serve it. */
export function connectCliInstall(publicUrl: string): string | null {
  const base = mirrorBaseFor(publicUrl);
  return base && mirroredCliAssets().length ? `curl -fsSL ${base}/install/netbird.sh | sh` : null;
}

/** Test hook: drop the manifest cache. */
export function resetNetbirdClientMirrorCache(): void {
  cached = null;
}
