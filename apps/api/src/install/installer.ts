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
import { renderSystemdUnit, SYSTEMD_UNIT_NAME, DEFAULT_ENV_FILE, DEFAULT_BINARY_PATH, DEFAULT_STATE_DIR } from './systemd';

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
  return `#!/usr/bin/env sh
# swarmy node installer (stage 2 of 2) — version ${version}
# Verified by the loader's pinned sha256 before reaching here.
set -eu

CONTROLLER_URL="\${SWARMY_CONTROLLER_URL:-${controllerUrl}}"
JOIN_TOKEN="\${SWARMY_JOIN_TOKEN:-}"
NODE_LABELS="\${SWARMY_NODE_LABELS:-}"
BACKEND="\${SWARMY_BACKEND:-auto}"
AGENT_IMAGE="\${SWARMY_AGENT_IMAGE:-${agentImage}}"
BINARY_BASE_URL="\${SWARMY_BINARY_BASE_URL:-${binaryBaseUrl}}"
STATE_VOLUME="\${SWARMY_STATE_VOLUME:-swarmy-agent}"
CONTAINER_NAME="swarmy-agent"
BIN_PATH="${DEFAULT_BINARY_PATH}"
ENV_FILE="${DEFAULT_ENV_FILE}"
STATE_DIR="${DEFAULT_STATE_DIR}"
UNIT_NAME="${SYSTEMD_UNIT_NAME}"

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
    rm -f "/etc/systemd/system/$UNIT_NAME"
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
    [ -z "$NODE_LABELS" ] || echo "SWARMY_NODE_LABELS=$NODE_LABELS"
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
  ok "swarmy-agent running as a container ($CONTAINER_NAME)."
  say "Logs: docker logs -f $CONTAINER_NAME"
}

if use_systemd; then
  install_systemd
else
  install_docker
fi

[ -z "$NODE_LABELS" ] || ok "Node labels: $NODE_LABELS"
ok "Done. This node should appear ONLINE in your dashboard within a few seconds."
`;
}
