/**
 * The real, version-pinned installer (stage 2 of the two-stage loader).
 *
 * Served at `GET /install/<version>/install.sh` and fetched + checksum-verified
 * by the tiny loader (see ./loader.ts). It is the big script: detect Docker,
 * detect the supervisor backend (native systemd binary, or Docker-container
 * fallback), download + verify the pinned agent, install + start the agent, and
 * support `--uninstall`. The agent itself negotiates swarm membership with the
 * controller (swarmJoin), so this script never handles swarm tokens.
 *
 * Backend selection (`SWARMY_BACKEND`):
 *   - `auto`    (default) — systemd if present, else docker container.
 *   - `systemd` — force the native binary + systemd unit.
 *   - `docker`  — force the agent-as-container backend.
 *
 * Pure render so it is checksum-stable + unit-testable.
 */
import {
  renderSystemdUnit,
  renderSnapshotUnit,
  SYSTEMD_UNIT_NAME,
  SNAPSHOT_UNIT_NAME,
  DEFAULT_ENV_FILE,
  DEFAULT_BINARY_PATH,
  DEFAULT_STATE_DIR,
} from './systemd';

export interface RenderInstallerOptions {
  controllerUrl: string;
  version: string;
  /** Container image for the docker-container backend. */
  agentImage: string;
  /** Base URL the native binary is downloaded from (`<base>/<platform>`). */
  binaryBaseUrl: string;
  /** Per-platform sha256 of the agent binary (e.g. { 'linux-x64': '…' }). */
  binarySha256: Record<string, string>;
}

/** A representative systemd unit baked into the installer (heredoc-written on the box). */
function unitTemplate(): string {
  return renderSystemdUnit({
    binaryPath: DEFAULT_BINARY_PATH,
    envFilePath: DEFAULT_ENV_FILE,
    stateDir: DEFAULT_STATE_DIR,
  });
}

export function renderInstaller(opts: RenderInstallerOptions): string {
  const { controllerUrl, version, agentImage, binaryBaseUrl } = opts;
  const shaCases = Object.entries(opts.binarySha256)
    .map(([platform, sha]) => `    ${platform}) echo "${sha.toLowerCase()}" ;;`)
    .join('\n');
  const unit = unitTemplate();
  const snapshotUnit = renderSnapshotUnit({ binaryPath: DEFAULT_BINARY_PATH, stateDir: DEFAULT_STATE_DIR });
  return `#!/usr/bin/env sh
# swarmy node installer (stage 2 of 2) — version ${version}
# Verified by the loader's pinned sha256 before reaching here.
set -eu

CONTROLLER_URL="\${SWARMY_CONTROLLER_URL:-${controllerUrl}}"
JOIN_TOKEN="\${SWARMY_JOIN_TOKEN:-}"
EXPLICIT_JOIN_TOKEN="$JOIN_TOKEN"
NODE_LABELS="\${SWARMY_NODE_LABELS:-}"
BACKEND="\${SWARMY_BACKEND:-auto}"
AGENT_IMAGE="\${SWARMY_AGENT_IMAGE:-${agentImage}}"
BINARY_BASE_URL="\${SWARMY_BINARY_BASE_URL:-${binaryBaseUrl}}"
STATE_VOLUME="\${SWARMY_STATE_VOLUME:-swarmy-agent}"
ALLOW_MESH="\${SWARMY_ALLOW_MESH:-true}"
MESH_SETUP_KEY="\${SWARMY_MESH_SETUP_KEY:-}"
MESH_MANAGEMENT_URL="\${SWARMY_MESH_MANAGEMENT_URL:-}"
MESH_DRIVER="\${SWARMY_MESH_DRIVER:-netbird}"
CONTAINER_NAME="swarmy-agent"
BIN_PATH="${DEFAULT_BINARY_PATH}"
ENV_FILE="${DEFAULT_ENV_FILE}"
STATE_DIR="${DEFAULT_STATE_DIR}"
UNIT_NAME="${SYSTEMD_UNIT_NAME}"
SNAPSHOT_UNIT="${SNAPSHOT_UNIT_NAME}"

UNINSTALL=""
for arg in "$@"; do
  case "$arg" in --uninstall) UNINSTALL=1 ;; esac
done

say()  { printf '\\033[38;5;209m▸\\033[0m %s\\n' "$1"; }
ok()   { printf '\\033[32m✓\\033[0m %s\\n' "$1"; }
warn() { printf '\\033[33m! %s\\033[0m\\n' "$1" >&2; }
die()  { printf '\\033[31m✗ %s\\033[0m\\n' "$1" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

sha_of() {
  if have sha256sum; then sha256sum "$1" | awk '{print $1}';
  elif have shasum; then shasum -a 256 "$1" | awk '{print $1}';
  else die "no sha256 tool"; fi
}

detect_platform() {
  _os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  _arch="$(uname -m)"
  case "$_arch" in
    x86_64|amd64) _arch=x64 ;;
    aarch64|arm64) _arch=arm64 ;;
    *) die "unsupported arch: $_arch" ;;
  esac
  echo "\${_os}-\${_arch}"
}

expected_sha() {
  case "$1" in
${shaCases}
    *) echo "" ;;
  esac
}

use_systemd() {
  [ "$BACKEND" = systemd ] && return 0
  [ "$BACKEND" = docker ] && return 1
  # auto: systemd present + running?
  have systemctl && [ -d /run/systemd/system ]
}

# --- uninstall ----------------------------------------------------------------
if [ -n "$UNINSTALL" ]; then
  say "Removing the swarmy agent…"
  if have systemctl && systemctl list-unit-files 2>/dev/null | grep -q "$UNIT_NAME"; then
    systemctl disable --now "$UNIT_NAME" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/$UNIT_NAME" "/etc/systemd/system/$SNAPSHOT_UNIT"
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
  if have docker; then
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
    docker volume rm "$STATE_VOLUME" >/dev/null 2>&1 || true
  fi
  [ -f "$BIN_PATH" ] && rm -f "$BIN_PATH" || true
  [ -f "$ENV_FILE" ] && { command -v shred >/dev/null 2>&1 && shred -u "$ENV_FILE" || rm -f "$ENV_FILE"; }
  ok "swarmy agent removed. Docker and any swarm membership were left untouched."
  exit 0
fi

# --- repair mode --------------------------------------------------------------
# Re-running the one-liner on an already-enrolled box is the SUPPORTED way to
# fix it: refresh the binary + credentials, keep the node identity (the saved
# session and the controller's node-bound token re-adoption preserve it), then
# run the doctor's repair ladder instead of blindly hoping.
REPAIR=""
if [ -f "$ENV_FILE" ] || [ -f "$STATE_DIR/agent.json" ] || { have docker && docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; }; then
  REPAIR=1
  say "Existing swarmy installation detected — running in REPAIR mode (identity is preserved)."
fi

# On repair, values not supplied with the one-liner are salvaged from the
# existing env file so a bare re-run never LOSES configuration.
if [ -n "$REPAIR" ] && [ -f "$ENV_FILE" ]; then
  OLD_JOIN_TOKEN="$(sed -n 's/^SWARMY_JOIN_TOKEN=//p' "$ENV_FILE" | head -1)"
  [ -n "$JOIN_TOKEN" ]         || JOIN_TOKEN="$OLD_JOIN_TOKEN"
  [ -n "$MESH_SETUP_KEY" ]     || MESH_SETUP_KEY="$(sed -n 's/^SWARMY_MESH_SETUP_KEY=//p' "$ENV_FILE" | head -1)"
  [ -n "$MESH_MANAGEMENT_URL" ] || MESH_MANAGEMENT_URL="$(sed -n 's/^SWARMY_MESH_MANAGEMENT_URL=//p' "$ENV_FILE" | head -1)"
  [ -n "$NODE_LABELS" ]        || NODE_LABELS="$(sed -n 's/^SWARMY_NODE_LABELS=//p' "$ENV_FILE" | head -1)"

  # A NEW, explicit join token (different from what's on disk) means the operator
  # wants this box to (re-)enroll under a possibly different org/controller — not
  # just refresh its binary/creds. The agent otherwise ignores SWARMY_JOIN_TOKEN
  # entirely whenever a local session file exists (it always prefers resuming its
  # saved session over joining fresh — see apps/agent/src/daemon.ts buildRegister),
  # which silently re-adopts the OLD node identity under the OLD org. Drop the
  # stale session so the agent is forced to perform a fresh join with the new token.
  if [ -n "$EXPLICIT_JOIN_TOKEN" ] && [ "$EXPLICIT_JOIN_TOKEN" != "$OLD_JOIN_TOKEN" ]; then
    DROP_AGENT_STATE=1
    if [ -f "$STATE_DIR/agent.json" ]; then
      say "New join token differs from the existing installation — dropping the saved agent session so this node re-enrolls fresh."
      rm -f "$STATE_DIR/agent.json"
    fi
  fi
fi

# --- derive WS URL ------------------------------------------------------------
case "$CONTROLLER_URL" in
  https://*) WS_URL="wss://\${CONTROLLER_URL#https://}/agent/ws" ;;
  http://*)  WS_URL="ws://\${CONTROLLER_URL#http://}/agent/ws" ;;
  *) die "SWARMY_CONTROLLER_URL must start with http:// or https://" ;;
esac
[ -n "$JOIN_TOKEN" ] || die "Set SWARMY_JOIN_TOKEN (mint one in the dashboard)."

# --- Docker (required by the agent for both backends) -------------------------
if have docker; then
  ok "Docker already present."
else
  say "Docker not found — installing via get.docker.com…"
  curl -fsSL https://get.docker.com | sh || die "Docker install failed."
fi
docker info >/dev/null 2>&1 || die "Docker is installed but not running (need root?)."

write_env() {
  mkdir -p "$(dirname "$ENV_FILE")"
  umask 077
  {
    echo "AGENT_WS_URL=$WS_URL"
    echo "SWARMY_AGENT_STATE=$STATE_DIR/agent.json"
    echo "SWARMY_JOIN_TOKEN=$JOIN_TOKEN"
    echo "SWARMY_ALLOW_MESH=$ALLOW_MESH"
    [ -z "$NODE_LABELS" ] || echo "SWARMY_NODE_LABELS=$NODE_LABELS"
    [ -z "$MESH_SETUP_KEY" ] || echo "SWARMY_MESH_SETUP_KEY=$MESH_SETUP_KEY"
    [ -z "$MESH_MANAGEMENT_URL" ] || echo "SWARMY_MESH_MANAGEMENT_URL=$MESH_MANAGEMENT_URL"
    echo "SWARMY_MESH_DRIVER=$MESH_DRIVER"
  } > "$ENV_FILE"
}

install_systemd() {
  say "Installing the native systemd backend…"
  platform="$(detect_platform)"
  exp="$(expected_sha "$platform")"
  [ -n "$exp" ] || die "no pinned binary for $platform"
  tmp="$(mktemp)"
  curl -fsSL "$BINARY_BASE_URL/$platform" -o "$tmp" || die "failed to download agent binary"
  got="$(sha_of "$tmp")"
  [ "$got" = "$exp" ] || die "agent binary checksum mismatch (expected $exp, got $got)"
  install -m 0755 "$tmp" "$BIN_PATH"
  rm -f "$tmp"
  mkdir -p "$STATE_DIR"
  write_env
  cat > "/etc/systemd/system/$UNIT_NAME" <<'SWARMY_UNIT_EOF'
${unit}SWARMY_UNIT_EOF
  cat > "/etc/systemd/system/$SNAPSHOT_UNIT" <<'SWARMY_SNAPSHOT_EOF'
${snapshotUnit}SWARMY_SNAPSHOT_EOF
  systemctl daemon-reload
  systemctl enable "$UNIT_NAME"
  # restart (not just enable --now): on a re-install the unit is already running
  # with the OLD binary + token, and enable --now won't replace it. Always
  # restart so the freshly-written binary and env file take effect.
  systemctl restart "$UNIT_NAME"
  ok "swarmy-agent running under systemd ($BIN_PATH)."
  say "Logs: journalctl -u $UNIT_NAME -f"
}

install_docker() {
  say "Installing the Docker-container backend…"
  docker pull "$AGENT_IMAGE" >/dev/null 2>&1 || warn "Could not pull a newer image; using local copy if present."
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  if [ -n "$DROP_AGENT_STATE" ]; then
    say "New join token differs from the existing installation — dropping the saved agent session volume so this node re-enrolls fresh."
    docker volume rm "$STATE_VOLUME" >/dev/null 2>&1 || true
  fi
  docker run -d \\
    --name "$CONTAINER_NAME" \\
    --restart unless-stopped \\
    -v /var/run/docker.sock:/var/run/docker.sock \\
    -v "$STATE_VOLUME":/var/lib/swarmy \\
    -e AGENT_WS_URL="$WS_URL" \\
    -e SWARMY_JOIN_TOKEN="$JOIN_TOKEN" \\
    -e SWARMY_NODE_LABELS="$NODE_LABELS" \\
    -e SWARMY_AGENT_STATE=/var/lib/swarmy/agent.json \\
    -e SWARMY_ALLOW_MESH="$ALLOW_MESH" \\
    -e SWARMY_MESH_SETUP_KEY="$MESH_SETUP_KEY" \\
    -e SWARMY_MESH_MANAGEMENT_URL="$MESH_MANAGEMENT_URL" \\
    -e SWARMY_MESH_DRIVER="$MESH_DRIVER" \\
    "$AGENT_IMAGE" >/dev/null || die "Failed to start the agent container."
  ok "swarmy-agent running as a container ($CONTAINER_NAME)."
  say "Logs: docker logs -f $CONTAINER_NAME"
}

if use_systemd; then
  install_systemd
else
  install_docker
fi

# --- verify -------------------------------------------------------------------
# Fresh installs: informational check (swarm join is controller-driven and may
# land seconds later — a warn here is normal). Repairs: run the doctor's FIX
# ladder so the one-liner actually heals what it can, then show the state.
if use_systemd; then
  sleep 5
  if [ -n "$REPAIR" ]; then
    say "Repair: running diagnostics + safe fixes (swarmy-agent doctor --repair)…"
    "$BIN_PATH" doctor --repair || warn "Some checks still failing — re-run 'swarmy-agent doctor' in a minute; mesh/swarm formation can lag."
  else
    "$BIN_PATH" doctor || warn "Checks above settle once the controller finishes orchestrating (mesh join + swarm formation)."
  fi
else
  [ -z "$REPAIR" ] || say "Repair (container backend): agent container re-created. Diagnostics: docker exec $CONTAINER_NAME bun run apps/agent/src/main.ts doctor"
fi

[ -z "$NODE_LABELS" ] || ok "Node labels: $NODE_LABELS"
[ -z "$MESH_SETUP_KEY" ] || ok "Mesh: joining \${MESH_DRIVER} before swarm formation."
ok "Done. This node should appear ONLINE in your dashboard within a few seconds."
`;
}
