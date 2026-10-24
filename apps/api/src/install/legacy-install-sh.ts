/**
 * The LEGACY node join script served at `GET /install.sh` (and the release
 * asset scripts/gen-install-sh.ts writes). Deprecated for the checksum-pinned
 * loader (`/install/loader.sh` → ./installer.ts); retiring it is the owner's
 * call. Until then it keeps the node installer's rules: a re-run keeps the
 * mesh settings as one unit (the shared `salvage_install_env`), and secrets
 * reach the agent only through the root-only 0600 env file, mounted read-only
 * and loaded by the agent. Never `-e` or `--env-file`: both copy the values
 * into `docker inspect`, and `-e` also shows them in `ps`. One deprecation
 * line goes to stderr; stdout and exit codes are unchanged.
 */
import { DEFAULT_ENV_FILE, DEFAULT_STATE_DIR } from './systemd';
import { REPAIR_ENV_SH } from './repair-env-sh';
import { LEGACY_ENV_SH } from './legacy-env-sh';

export interface RenderLegacyInstallOptions {
  controllerUrl: string;
  agentImage: string;
  /** Add a comment block hinting at first-node swarm-manager init. */
  manager?: boolean;
}

const MANAGER_HINT = `
# --- swarm-manager hint -------------------------------------------------------
# This node is intended to be the FIRST node / swarm manager. Once the agent is
# online, the controller will ask it to run \`docker swarm init\` so the rest of
# your fleet can join. You can also pre-initialise the swarm yourself with:
#   docker swarm init
# Subsequent nodes you enrol will be joined to this manager automatically.
# -----------------------------------------------------------------------------
`;

export function renderLegacyInstallScript(opts: RenderLegacyInstallOptions): string {
  const { controllerUrl: url, agentImage } = opts;
  return `#!/usr/bin/env sh
# swarmy node installer (LEGACY, deprecated). The current installer:
#   curl -fsSL ${url}/install/loader.sh | SWARMY_JOIN_TOKEN=swt_xxx sh -s -- --controller ${url}
#
#   Install / re-run (keeps this node's settings, mesh included):
#     curl -fsSL ${url}/install.sh | SWARMY_JOIN_TOKEN=swt_xxx sh
#   With node labels:  … | SWARMY_JOIN_TOKEN=swt_xxx SWARMY_NODE_LABELS=role=web,region=eu sh
#   Uninstall (the agent + its env file; leaves Docker & the swarm untouched):
#     curl -fsSL ${url}/install.sh | sh -s -- --uninstall
#
# Run as root: the join token and mesh key live in ${DEFAULT_ENV_FILE} (0600),
# which the agent container reads; they never appear on its command line.
${opts.manager ? MANAGER_HINT : ''}set -eu

CONTROLLER_URL="\${SWARMY_CONTROLLER_URL:-${url}}"
CONTROLLER_URL="\${CONTROLLER_URL%/}"
JOIN_TOKEN="\${SWARMY_JOIN_TOKEN:-}"
AGENT_IMAGE="\${SWARMY_AGENT_IMAGE:-${agentImage}}"
STATE_VOLUME="\${SWARMY_STATE_VOLUME:-swarmy-agent}"
NODE_LABELS="\${SWARMY_NODE_LABELS:-}"
ALLOW_BUILD="\${SWARMY_ALLOW_BUILD:-}"
# ALLOW_MESH / MESH_DRIVER default after the re-run salvage (true / netbird), as
# in the node installer, so a re-run keeps a node's mesh opt-out and driver.
ALLOW_MESH="\${SWARMY_ALLOW_MESH:-}"
MESH_SETUP_KEY="\${SWARMY_MESH_SETUP_KEY:-}"
MESH_MANAGEMENT_URL="\${SWARMY_MESH_MANAGEMENT_URL:-}"
MESH_DRIVER="\${SWARMY_MESH_DRIVER:-}"
MESH_CA_B64="\${SWARMY_MESH_CA_B64:-}"
CONTAINER_NAME="swarmy-agent"
ENV_FILE="${DEFAULT_ENV_FILE}"
# The agent's state dir inside the container (the $STATE_VOLUME mount).
STATE_DIR="${DEFAULT_STATE_DIR}"

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

warn "/install.sh is deprecated; use the current installer: curl -fsSL $CONTROLLER_URL/install/loader.sh | SWARMY_JOIN_TOKEN=<token> sh -s -- --controller $CONTROLLER_URL"

command -v docker >/dev/null 2>&1 || DOCKER_MISSING=1

${REPAIR_ENV_SH}
${LEGACY_ENV_SH}
# --- uninstall: the agent, its state volume and the env file ------------------
if [ -n "$UNINSTALL" ]; then
  uninstall_agent
  exit 0
fi

# --- install / reconcile ------------------------------------------------------
# Derive the agent WebSocket URL from the controller URL (http→ws, https→wss).
case "$CONTROLLER_URL" in
  https://*) WS_URL="wss://\${CONTROLLER_URL#https://}/agent/ws" ;;
  http://*)  WS_URL="ws://\${CONTROLLER_URL#http://}/agent/ws" ;;
  *) die "SWARMY_CONTROLLER_URL must start with http:// or https://" ;;
esac

# A re-run re-creates the agent with the latest image and keeps its identity
# (the $STATE_VOLUME session) and its settings: whatever the one-liner leaves
# unset comes back from the env file, the mesh settings as one unit.
if [ -f "$ENV_FILE" ] || { [ -z "\${DOCKER_MISSING:-}" ] && docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; }; then
  say "Existing swarmy agent detected — reconciling (image + config, settings kept)…"
  need_env_dir
  [ -f "$ENV_FILE" ] || seed_env_from_container "$CONTAINER_NAME"
  salvage_install_env "$ENV_FILE"
else
  say "Starting the swarmy agent…"
fi
[ -n "$ALLOW_MESH" ] || ALLOW_MESH=true
[ -n "$MESH_DRIVER" ] || MESH_DRIVER=netbird
# A key the agent will ignore must not vanish silently.
if [ -n "$MESH_SETUP_KEY" ] && [ "$ALLOW_MESH" != true ]; then
  warn "SWARMY_ALLOW_MESH=$ALLOW_MESH on this node: the mesh setup key is kept but NOT used (no mesh client starts). Re-run with SWARMY_ALLOW_MESH=true to join the mesh."
fi
[ -n "$JOIN_TOKEN" ] || die "Set SWARMY_JOIN_TOKEN (mint one in the dashboard → Settings → Join tokens)."
need_env_dir

if [ -n "\${DOCKER_MISSING:-}" ]; then
  say "Docker not found — installing via get.docker.com…"
  curl -fsSL https://get.docker.com | sh || die "Docker install failed."
  ok "Docker installed."
else
  ok "Docker already present — skipping install."
fi
docker info >/dev/null 2>&1 || die "Docker is installed but not running (need root? try: sudo sh)."

say "Pulling the agent image ($AGENT_IMAGE)…"
docker pull "$AGENT_IMAGE" >/dev/null 2>&1 || warn "Could not pull a newer image; using the local copy if present."

docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
# Secrets ride the 0600 env file, mounted read-only (the agent loads it; -e wins).
write_env
docker run -d \\
  --name "$CONTAINER_NAME" \\
  --restart unless-stopped \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  -v "$STATE_VOLUME":"$STATE_DIR" \\
  -v "$ENV_FILE":${DEFAULT_ENV_FILE}:ro \\
  -e AGENT_WS_URL="$WS_URL" \\
  -e SWARMY_NODE_LABELS="$NODE_LABELS" \\
  -e SWARMY_AGENT_STATE="$STATE_DIR/agent.json" \\
  -e SWARMY_ALLOW_MESH="$ALLOW_MESH" \\
  -e SWARMY_ALLOW_BUILD="$ALLOW_BUILD" \\
  -e SWARMY_MESH_MANAGEMENT_URL="$MESH_MANAGEMENT_URL" \\
  -e SWARMY_MESH_DRIVER="$MESH_DRIVER" \\
  "$AGENT_IMAGE" >/dev/null || die "Failed to start the agent container."

[ -z "$NODE_LABELS" ] || ok "Node labels: $NODE_LABELS"
[ -z "$MESH_SETUP_KEY" ] || [ "$ALLOW_MESH" != true ] || ok "Mesh: joining \${MESH_DRIVER} before swarm formation."
ok "Done. This node should appear ONLINE in your dashboard within a few seconds."
say "Logs:      docker logs -f $CONTAINER_NAME"
say "Uninstall: curl -fsSL $CONTROLLER_URL/install.sh | sh -s -- --uninstall"
`;
}
