/**
 * Renders the live node-install scripts. `GET /install.sh` is the LEGACY join
 * script (./install/legacy-install-sh.ts), deprecated for the checksum-pinned
 * two-stage loader (`/install/loader.sh` → ./install/installer.ts) and kept
 * safe until it is retired. The controller bakes in its own public URL so the
 * agent connects back correctly. The join token is supplied by the operator via
 * the env in the one-liner (`… | SWARMY_JOIN_TOKEN=swt_… sh`) — never via the
 * URL, so it stays out of proxy/CDN access logs.
 */
import { renderInstaller, type RenderInstallerOptions } from './install/installer';
import { renderLoader, renderChecksumFile, sha256Hex } from './install/loader';
import { renderLegacyInstallScript } from './install/legacy-install-sh';

export { renderInstaller, renderLoader, renderChecksumFile, sha256Hex };
export { renderSystemdUnit, renderAgentEnvFile } from './install/systemd';

/**
 * Pinned install configuration resolved from env (set by the release pipeline).
 * The loader bakes in the version + the installer's sha256 so `curl | sh` is
 * checksum-honest; the installer in turn pins per-platform agent-binary hashes.
 */
export interface InstallConfig {
  version: string;
  agentImage: string;
  binaryBaseUrl: string;
  binarySha256: Record<string, string>;
}

/** Resolve the pinned install config from the controller's environment. */
export function resolveInstallConfig(controllerUrl: string): InstallConfig {
  const version = process.env.SWARMY_AGENT_VERSION ?? '0.0.0';
  const agentImage = process.env.SWARMY_AGENT_IMAGE ?? 'ghcr.io/requestflo/swarmy-agent:latest';
  const binaryBaseUrl = process.env.SWARMY_BINARY_BASE_URL ?? `${controllerUrl}/install/${version}/agent`;
  let binarySha256: Record<string, string> = {};
  if (process.env.SWARMY_BINARY_SHA256) {
    try {
      binarySha256 = JSON.parse(process.env.SWARMY_BINARY_SHA256) as Record<string, string>;
    } catch {
      binarySha256 = {};
    }
  }
  return { version, agentImage, binaryBaseUrl, binarySha256 };
}

/** Render the real, version-pinned installer for a given controller + config. */
export function renderPinnedInstaller(controllerUrl: string, cfg: InstallConfig): string {
  const opts: RenderInstallerOptions = {
    controllerUrl,
    version: cfg.version,
    agentImage: cfg.agentImage,
    binaryBaseUrl: cfg.binaryBaseUrl,
    binarySha256: cfg.binarySha256,
  };
  return renderInstaller(opts);
}

/** Render the tiny two-stage loader (the body piped into the user's shell). */
export function renderPinnedLoader(controllerUrl: string, cfg: InstallConfig): string {
  const installerBody = renderPinnedInstaller(controllerUrl, cfg);
  return renderLoader({
    controllerUrl,
    version: cfg.version,
    installerSha256: sha256Hex(installerBody),
  });
}

export interface RenderInstallScriptOptions {
  /** When true, add a comment block hinting at first-node swarm-manager init. */
  manager?: boolean;
}

/** The legacy `GET /install.sh` body (deprecated; see ./install/legacy-install-sh.ts). */
export function renderInstallScript(controllerUrl: string, opts: RenderInstallScriptOptions = {}): string {
  const agentImage = process.env.SWARMY_AGENT_IMAGE ?? 'ghcr.io/requestflo/swarmy-agent:latest';
  return renderLegacyInstallScript({ controllerUrl, agentImage, manager: opts.manager });
}
