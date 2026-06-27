/**
 * Renders the live node-install script served at `GET /install.sh`.
 * The controller bakes in its own public URL so the agent connects back
 * correctly. The join token is supplied by the operator via the env in the
 * one-liner (`… | SWARMY_JOIN_TOKEN=swt_… sh`) — never via the URL, so it stays
 * out of proxy/CDN access logs.
 *
 * MVP of the node-onboarding epic (see plans/epic-node-onboarding.md). The
 * script is idempotent (safe to re-run), detects an already-installed agent and
 * reconciles instead of duplicating, forwards optional node labels to the agent
 * via `SWARMY_NODE_LABELS`, and ships an `--uninstall` path.
 *
 * Deferred (see plan): checksum-pinned two-stage loader, native systemd backend,
 * .deb/.rpm packages, full manager-vs-worker swarm auto-join.
 */
import { renderInstaller, type RenderInstallerOptions } from './install/installer';
import { renderLoader, renderChecksumFile, sha256Hex } from './install/loader';

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

export function renderInstallScript(controllerUrl: string, opts: RenderInstallScriptOptions = {}): string {
  const agentImage = process.env.SWARMY_AGENT_IMAGE ?? 'ghcr.io/requestflo/swarmy-agent:latest';
  const managerHint = opts.manager
    ? `
# --- swarm-manager hint -------------------------------------------------------
# This node is intended to be the FIRST node / swarm manager. Once the agent is
# online, the controller will ask it to run \`docker swarm init\` so the rest of
# your fleet can join. You can also pre-initialise the swarm yourself with:
#   docker swarm init
# Subsequent nodes you enrol will be joined to this manager automatically.
# -----------------------------------------------------------------------------
`
    : '';
  return `#!/usr/bin/env sh
# swarmy node installer
#
#   Install / re-run (idempotent):
#     curl -fsSL ${controllerUrl}/install.sh | SWARMY_JOIN_TOKEN=swt_xxx sh
#
#   With node labels (comma-separated key=value pairs):
#     curl -fsSL ${controllerUrl}/install.sh | \\
#       SWARMY_JOIN_TOKEN=swt_xxx SWARMY_NODE_LABELS=role=web,region=eu sh
#
#   Uninstall (removes the agent container; leaves Docker & the swarm untouched):
#     curl -fsSL ${controllerUrl}/install.sh | sh -s -- --uninstall
#
# Installs Docker (if missing), then runs the swarmy agent which dials out to
# your controller over an authenticated WebSocket and registers this node.
${managerHint}set -eu

CONTROLLER_URL="\${SWARMY_CONTROLLER_URL:-${controllerUrl}}"
JOIN_TOKEN="\${SWARMY_JOIN_TOKEN:-}"
AGENT_IMAGE="\${SWARMY_AGENT_IMAGE:-${agentImage}}"
STATE_VOLUME="\${SWARMY_STATE_VOLUME:-swarmy-agent}"
NODE_LABELS="\${SWARMY_NODE_LABELS:-}"
CONTAINER_NAME="swarmy-agent"

# --uninstall may also be passed as the first arg (… | sh -s -- --uninstall).
UNINSTALL="\${SWARMY_UNINSTALL:-}"
for arg in "$@"; do
  case "$arg" in
    --uninstall) UNINSTALL=1 ;;
  esac
done

say()  { printf '\\033[38;5;209m▸\\033[0m %s\\n' "$1"; }
ok()   { printf '\\033[32m✓\\033[0m %s\\n' "$1"; }
warn() { printf '\\033[33m! %s\\033[0m\\n' "$1" >&2; }
die()  { printf '\\033[31m✗ %s\\033[0m\\n' "$1" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || DOCKER_MISSING=1

# --- uninstall ----------------------------------------------------------------
if [ -n "$UNINSTALL" ]; then
  [ -z "\${DOCKER_MISSING:-}" ] || die "Docker not found — nothing to uninstall."
  say "Removing the swarmy agent…"
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker volume rm "$STATE_VOLUME" >/dev/null 2>&1 || true
  ok "swarmy agent removed. Docker and any swarm membership were left untouched."
  say "To also leave the swarm:  docker swarm leave --force"
  exit 0
fi

# --- install / reconcile ------------------------------------------------------
# Derive the agent WebSocket URL from the controller URL (http→ws, https→wss).
case "$CONTROLLER_URL" in
  https://*) WS_URL="wss://\${CONTROLLER_URL#https://}/agent/ws" ;;
  http://*)  WS_URL="ws://\${CONTROLLER_URL#http://}/agent/ws" ;;
  *) die "SWARMY_CONTROLLER_URL must start with http:// or https://" ;;
esac

[ -n "$JOIN_TOKEN" ] || die "Set SWARMY_JOIN_TOKEN (mint one in the dashboard → Settings → Join tokens)."

if [ -n "\${DOCKER_MISSING:-}" ]; then
  say "Docker not found — installing via get.docker.com…"
  curl -fsSL https://get.docker.com | sh || die "Docker install failed."
  ok "Docker installed."
else
  ok "Docker already present — skipping install."
fi
docker info >/dev/null 2>&1 || die "Docker is installed but not running (need root? try: sudo sh)."

# Idempotent: if the agent is already running, reconcile (re-create with the
# latest image/config) rather than spinning up a duplicate. The agent keeps its
# identity via the persisted state in the \$STATE_VOLUME volume, so re-running is
# always safe and never consumes a fresh join-token use.
if docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  say "Existing swarmy agent detected — reconciling (image + config)…"
else
  say "Starting the swarmy agent…"
fi

say "Pulling the agent image ($AGENT_IMAGE)…"
docker pull "$AGENT_IMAGE" >/dev/null 2>&1 || warn "Could not pull a newer image; using the local copy if present."

docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
docker run -d \\
  --name "$CONTAINER_NAME" \\
  --restart unless-stopped \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  -v "$STATE_VOLUME":/var/lib/swarmy \\
  -e AGENT_WS_URL="$WS_URL" \\
  -e SWARMY_JOIN_TOKEN="$JOIN_TOKEN" \\
  -e SWARMY_NODE_LABELS="$NODE_LABELS" \\
  -e SWARMY_AGENT_STATE=/var/lib/swarmy/agent.json \\
  "$AGENT_IMAGE" >/dev/null || die "Failed to start the agent container."

[ -z "$NODE_LABELS" ] || ok "Node labels: $NODE_LABELS"
ok "Done. This node should appear ONLINE in your dashboard within a few seconds."
say "Logs:      docker logs -f $CONTAINER_NAME"
say "Uninstall: curl -fsSL $CONTROLLER_URL/install.sh | sh -s -- --uninstall"
`;
}
