/**
 * The NetBird client download mirror (plans/epic-self-hosted-mesh-and-fleets.md
 * §3.4 step 1, M3): the desktop installers people need for "Connect from your
 * laptop", served by the controller itself (like the agent binaries at
 * /install/bin) so connecting never depends on GitHub being reachable.
 *
 * The controller image bakes the files at build time (scripts/
 * fetch-netbird-clients.ts → `manifest.json`), each checked against the
 * sha256 pinned HERE: NetBird's release `checksums.txt` doesn't cover the
 * .pkg/.exe installers, so the pins are ours. A file the build couldn't fetch
 * is simply absent from the manifest and its link falls back to upstream.
 * Phones get the app stores (never mirrored).
 *
 * Pure: no I/O. Bump the list together with the `netbirdClient` BOM entry
 * (a test holds the two to one version).
 */

/** The client release the mirror pins (matches the BOM's `netbirdClient` tag). */
export const NETBIRD_CLIENT_DOWNLOAD_VERSION = '0.79.0';

export type ClientPlatform = 'macos-arm64' | 'macos-amd64' | 'windows-amd64' | 'windows-arm64' | 'linux-amd64' | 'linux-arm64';

export interface ClientDownloadAsset {
  platform: ClientPlatform;
  /** What a person reads ("macOS (Apple silicon)"). */
  label: string;
  /** The release asset name: also the only path the controller serves it under. */
  file: string;
  sha256: string;
  size: number;
}

const v = NETBIRD_CLIENT_DOWNLOAD_VERSION;

/** Pinned 2026-10-24 from the v0.79.0 release (Linux tarballs also match its checksums.txt). */
export const NETBIRD_CLIENT_DOWNLOADS: readonly ClientDownloadAsset[] = [
  { platform: 'macos-arm64', label: 'macOS (Apple silicon)', file: `netbird_${v}_darwin_arm64.pkg`, sha256: '706bf4a11cdfc7d7d235b9239cda3a08ec8b1d6b85d669bd7f06829a1025db8b', size: 22926434 },
  { platform: 'macos-amd64', label: 'macOS (Intel)', file: `netbird_${v}_darwin_amd64.pkg`, sha256: '3d8c0384b70aaf837768054325a64a94e80c4335890c1fc7b29bbe5b734d2569', size: 25343402 },
  { platform: 'windows-amd64', label: 'Windows (x64)', file: `netbird_installer_${v}_windows_amd64.exe`, sha256: '3150d04219379ba4948eb724d75c20039928d032f99326b82370af013589f54a', size: 20771560 },
  { platform: 'windows-arm64', label: 'Windows (Arm)', file: `netbird_installer_${v}_windows_arm64.exe`, sha256: 'ecfa3358e07f0ce127aa0af1b5d17ef278c5e820814dfde611f2097f200bfcf2', size: 18095576 },
  { platform: 'linux-amd64', label: 'Linux (x64, CLI)', file: `netbird_${v}_linux_amd64.tar.gz`, sha256: 'd6f8d26fa21527772f87094557e1196f2a669b1ab4033f650424dce33ba71efd', size: 15933764 },
  { platform: 'linux-arm64', label: 'Linux (Arm64, CLI)', file: `netbird_${v}_linux_arm64.tar.gz`, sha256: '275a98268c84422a66e18c7d771015284b8856400174536beb8b0ce737cdadd3', size: 14585432 },
];

/** Where an asset lives upstream (the fallback when the controller has no copy). */
export function upstreamClientUrl(file: string, version = NETBIRD_CLIENT_DOWNLOAD_VERSION): string {
  return `https://github.com/netbirdio/netbird/releases/download/v${version}/${file}`;
}

/** Phones: the stores only (not mirrorable). */
export const NETBIRD_MOBILE_LINKS = [
  { platform: 'ios', label: 'iPhone / iPad (App Store)', url: 'https://apps.apple.com/app/netbird-p2p-vpn/id6469329339' },
  { platform: 'android', label: 'Android (Google Play)', url: 'https://play.google.com/store/apps/details?id=io.netbird.client' },
] as const;

/** What the controller serves: `manifest.json` next to the files. */
export interface ClientMirrorManifest {
  version: string;
  files: Record<string, { sha256: string; size: number }>;
}

const SHA256_RE = /^[a-f0-9]{64}$/;

/**
 * A manifest is trusted only where it agrees with the pins: unknown files and
 * any file whose hash differs from the pin are dropped. Null for junk.
 */
export function parseClientMirrorManifest(raw: unknown): ClientMirrorManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as { version?: unknown; files?: unknown };
  if (m.version !== NETBIRD_CLIENT_DOWNLOAD_VERSION || !m.files || typeof m.files !== 'object') return null;
  const files: ClientMirrorManifest['files'] = {};
  for (const a of NETBIRD_CLIENT_DOWNLOADS) {
    const f = (m.files as Record<string, { sha256?: unknown; size?: unknown }>)[a.file];
    if (!f || typeof f.sha256 !== 'string' || !SHA256_RE.test(f.sha256) || f.sha256 !== a.sha256) continue;
    files[a.file] = { sha256: a.sha256, size: a.size };
  }
  return { version: NETBIRD_CLIENT_DOWNLOAD_VERSION, files };
}

/** The one gate on the served path: only an exact listed file name, never a path. */
export function servableClientFile(name: string): ClientDownloadAsset | null {
  return NETBIRD_CLIENT_DOWNLOADS.find((a) => a.file === name) ?? null;
}

export interface ClientDownloadLink {
  platform: string;
  label: string;
  url: string;
  /** Served by this cluster's controller (vs upstream / an app store). */
  mirrored: boolean;
  sha256?: string;
  size?: number;
}

/** Per-platform links: the controller's copy when it has one, else upstream; then the stores. */
export function clientDownloads(manifest: ClientMirrorManifest | null, controllerBase: string): ClientDownloadLink[] {
  const base = controllerBase.replace(/\/+$/, '');
  const desktop = NETBIRD_CLIENT_DOWNLOADS.map((a): ClientDownloadLink => {
    const mirrored = Boolean(manifest?.files[a.file]);
    return {
      platform: a.platform,
      label: a.label,
      url: mirrored ? `${base}/install/netbird/${a.file}` : upstreamClientUrl(a.file),
      mirrored,
      sha256: a.sha256,
      size: a.size,
    };
  });
  return [...desktop, ...NETBIRD_MOBILE_LINKS.map((l) => ({ platform: l.platform, label: l.label, url: l.url, mirrored: false }))];
}
