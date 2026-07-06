// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The controller's local agent-binary release: which agent version this
 * controller can hand out, per platform, with checksums.
 *
 * Source of truth is a directory of compiled binaries + `manifest.json`
 * produced by `scripts/build-agent-binaries.ts` (baked into the controller
 * image at /app/agent-binaries; `SWARMY_AGENT_BIN_DIR` overrides). The
 * controller serves the binaries itself at `/install/bin/<platform>` — your
 * cloud never depends on ours for updates.
 *
 * Consumed by: the install routes (serve + pin checksums into the installer)
 * and the nodes router (`agent.update` dispatch + "update available" UX).
 * When the directory is absent (dev without a compile step) everything
 * degrades gracefully: no release, no update offers, container backend only.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface AgentReleaseManifest {
  version: string;
  commit?: string;
  platforms: Record<string, { sha256: string; size: number }>;
}

const MANIFEST_TTL_MS = 30_000;

let cached: { manifest: AgentReleaseManifest | null; dir: string; at: number } | null = null;

export function agentBinDir(): string {
  return process.env.SWARMY_AGENT_BIN_DIR ?? path.resolve(process.cwd(), 'apps/agent/dist-bin');
}

/** The manifest of locally-available agent binaries, or null when none are built. */
export function agentRelease(): AgentReleaseManifest | null {
  const dir = agentBinDir();
  const now = Date.now();
  if (cached && cached.dir === dir && now - cached.at < MANIFEST_TTL_MS) return cached.manifest;
  let manifest: AgentReleaseManifest | null = null;
  try {
    const raw = readFileSync(path.join(dir, 'manifest.json'), 'utf8');
    const parsed = JSON.parse(raw) as AgentReleaseManifest;
    if (parsed && typeof parsed.version === 'string' && parsed.platforms) manifest = parsed;
  } catch {
    manifest = null; // no binaries built — systemd/self-update paths simply unavailable
  }
  cached = { manifest, dir, at: now };
  return manifest;
}

/** Absolute path of a released binary, verified to exist, or null. */
export function agentBinaryPath(platform: string): string | null {
  const release = agentRelease();
  if (!release?.platforms[platform]) return null;
  if (!/^[a-z0-9-]+$/.test(platform)) return null; // path-traversal guard
  const p = path.join(agentBinDir(), `swarmy-agent-${platform}`);
  return existsSync(p) ? p : null;
}

/**
 * Map a node's reported arch (Docker `Description.Platform.Architecture` or
 * `uname -m`) to a binary platform key. Linux-only — the compiled agent
 * targets linux; darwin builds are dev-local.
 */
export function platformForArch(arch: string | null | undefined): string | null {
  switch ((arch ?? '').toLowerCase()) {
    case 'x86_64':
    case 'amd64':
    case 'x64':
      return 'linux-x64';
    case 'aarch64':
    case 'arm64':
      return 'linux-arm64';
    default:
      return null;
  }
}

/** Test hook: drop the manifest cache. */
export function resetAgentReleaseCache(): void {
  cached = null;
}
