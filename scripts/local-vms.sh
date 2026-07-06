#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
#
# Spin up local multipass VMs as REAL swarmy nodes, enrolled the SAME WAY a
# production box is: the two-stage `curl … | sh` installer downloads the
# Bun-compiled agent binary from your controller, installs it as a systemd
# service, and the node dials home. No Docker image to build or transfer.
#
#   bash scripts/local-vms.sh up        # launch + enroll (default 2 nodes)
#   bash scripts/local-vms.sh status    # multipass state + per-node agent state
#   bash scripts/local-vms.sh logs 1    # follow the agent journal on node 1
#   bash scripts/local-vms.sh reenroll  # re-run the installer on existing VMs
#   bash scripts/local-vms.sh down      # delete + purge all swarmy-node-* VMs
#
# PREREQUISITE: a controller running on this Mac, reachable on your LAN and
# serving the agent binaries. From the repo root:
#     bun run dev:up          # Postgres + schema + seed (one time / after resets)
#     bun run build:agent-bin # compile the linux agent binaries (this script also does it)
#     bun dev:app             # controller :3001 + dashboard :3003
# The controller serves binaries automatically once they're built (it looks in
# apps/agent/dist-bin); this script builds them for you and checks reachability.
#
# Tunables (env):
#   SWARMY_VM_COUNT=2            how many VMs
#   SWARMY_VM_CPUS=1 MEM=1G DISK=6G
#   SWARMY_VM_RELEASE=24.04      Ubuntu release
#   SWARMY_BACKEND=systemd       agent backend: systemd (native binary) | docker
#   SWARMY_CONTROLLER_IP=…       host IP the VMs dial (default: en0/en1 LAN IP)
#   SWARMY_CONTROLLER_PORT=3001
#   SWARMY_JOIN_TOKEN=…          (default: mint a fresh one via scripts/mint-token.ts)
#   SWARMY_VM_BRIDGE=en0         bridge VMs onto your LAN instead of NAT
#   SWARMY_ALLOW_MESH=false      agent capability flags
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

PREFIX="swarmy-node"
COUNT="${SWARMY_VM_COUNT:-2}"
CPUS="${SWARMY_VM_CPUS:-1}"
MEM="${SWARMY_VM_MEM:-1G}"
DISK="${SWARMY_VM_DISK:-6G}"
RELEASE="${SWARMY_VM_RELEASE:-24.04}"
CONTROLLER_PORT="${SWARMY_CONTROLLER_PORT:-3001}"
BACKEND="${SWARMY_BACKEND:-systemd}"
ALLOW_MESH="${SWARMY_ALLOW_MESH:-false}"

say()  { printf '\033[1;36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

need_multipass() {
  command -v multipass >/dev/null 2>&1 || die "multipass not installed (brew install --cask multipass)."
  multipass version >/dev/null 2>&1 || die "Can't reach multipassd. Start it:
    sudo launchctl bootstrap system /Library/LaunchDaemons/com.canonical.multipassd.plist
    sudo launchctl kickstart -k system/com.canonical.multipassd"
}

resolve_controller_ip() {
  HOST_IP="${SWARMY_CONTROLLER_IP:-$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)}"
  [ -n "$HOST_IP" ] || die "Could not determine this Mac's LAN IP. Set SWARMY_CONTROLLER_IP=…"
  CONTROLLER_URL="http://${HOST_IP}:${CONTROLLER_PORT}"
}

# Pick a bridged LAN interface if available (VMs share the Mac's IP range),
# else NAT (still reaches the controller at HOST_IP).
resolve_network() {
  local want="${SWARMY_VM_BRIDGE:-en0}"
  NETWORK_ARGS=()
  if multipass networks 2>/dev/null | awk 'NR>1{print $1}' | grep -qx "$want"; then
    NETWORK_ARGS=(--network "name=${want},mode=auto")
    NET_DESC="bridged via ${want}"
  else
    NET_DESC="NAT (reaches controller at ${HOST_IP})"
  fi
}

# Build the linux agent binaries + manifest the controller serves at
# /install/bin/<platform>. Fast (a few hundred ms per target) and idempotent.
build_binaries() {
  say "Compiling linux agent binaries (bun --compile)…"
  SWARMY_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo dev)" \
    bun run scripts/build-agent-binaries.ts >/dev/null
  ok "Agent binaries built (apps/agent/dist-bin)."
}

# The controller must be reachable at the LAN IP AND serving the binaries.
preflight_controller() {
  MANIFEST="$(curl -fsS --max-time 5 "${CONTROLLER_URL}/install/bin/manifest.json" 2>/dev/null || true)"
  [ -n "$MANIFEST" ] || die "Controller not serving agent binaries at ${CONTROLLER_URL}/install/bin/manifest.json.
    Is 'bun dev:app' running, and were the binaries built? This machine reaches it at ${HOST_IP};
    the controller binds all interfaces by default. If it only answers on localhost, restart it."
  AGENT_VERSION="$(printf '%s' "$MANIFEST" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
  [ -n "$AGENT_VERSION" ] || die "Could not read agent version from the manifest."
  ok "Controller serving agent binaries at ${CONTROLLER_URL} (version ${AGENT_VERSION})."
}

resolve_token() {
  if [ -n "${SWARMY_JOIN_TOKEN:-}" ]; then
    TOKEN="$SWARMY_JOIN_TOKEN"; return
  fi
  say "Minting a fresh join token…"
  TOKEN="$(bun --env-file=.env run scripts/mint-token.ts 2>/dev/null | tail -1 | tr -d '[:space:]')"
  [ -n "$TOKEN" ] || die "Could not mint a join token. Run 'bun run dev:up' first (seeds the dev org)."
}

# Run a command with a hard wall-clock cap (macOS has no `timeout`).
# multipassd (1.16.x + qemu) intermittently wedges a `multipass exec`; the cap
# turns an indefinite hang into a recoverable failure.
guarded() {
  local secs="$1"; shift
  ( "$@" & local p=$!
    ( sleep "$secs"; kill -9 "$p" 2>/dev/null ) & local k=$!
    wait "$p"; local rc=$?; kill "$k" 2>/dev/null; return "$rc" )
}

# Fetch + run the installer on a VM, pointing every URL at the LAN controller.
# We fetch the installer DIRECTLY (skipping the two-stage checksum loader — the
# loader's job is to protect an untrusted `curl|sh`, which local dev doesn't
# need) and pass SWARMY_CONTROLLER_URL / SWARMY_BINARY_BASE_URL so it works no
# matter what CONTROLLER_PUBLIC_URL the controller bakes. The installer still
# sha256-verifies the downloaded binary against the manifest.
enroll_node() {
  local name="$1"
  local install_url="${CONTROLLER_URL}/install/${AGENT_VERSION}/install.sh"
  guarded 300 multipass exec "$name" -- sudo env \
    SWARMY_JOIN_TOKEN="$TOKEN" \
    SWARMY_BACKEND="$BACKEND" \
    SWARMY_CONTROLLER_URL="$CONTROLLER_URL" \
    SWARMY_BINARY_BASE_URL="${CONTROLLER_URL}/install/bin" \
    SWARMY_NODE_LABELS="local-vm,${name}" \
    SWARMY_ALLOW_MESH="$ALLOW_MESH" \
    bash -c "curl -fsSL '$install_url' | sh"
}

up() {
  need_multipass; resolve_controller_ip; resolve_network
  build_binaries; preflight_controller; resolve_token

  say "Launching ${COUNT} × Ubuntu ${RELEASE} (${CPUS} CPU / ${MEM} / ${DISK}) — ${NET_DESC}"
  printf '    controller : %s\n    backend    : %s\n    join token : %s…\n\n' \
    "$CONTROLLER_URL" "$BACKEND" "${TOKEN:0:14}"

  for i in $(seq 1 "$COUNT"); do
    local name="${PREFIX}-${i}"
    if multipass info "$name" >/dev/null 2>&1; then
      warn "[$name] exists — re-running the installer (idempotent)."
    else
      say "[$name] launching…"
      multipass launch "$RELEASE" --name "$name" \
        --cpus "$CPUS" --memory "$MEM" --disk "$DISK" "${NETWORK_ARGS[@]}"
    fi
    say "[$name] installing agent (${BACKEND}) ← ${CONTROLLER_URL}"
    if enroll_node "$name"; then
      ok "[$name] agent installed — should reach ONLINE shortly."
    else
      warn "[$name] install hung/failed. Recover: multipass restart $name && bash scripts/local-vms.sh reenroll"
    fi
  done

  echo; ok "Done. Dashboard → Infrastructure; ${COUNT} node(s) should go ONLINE within seconds."
  say "Tail an agent:  bash scripts/local-vms.sh logs 1"
}

# Re-run the installer on already-launched VMs (e.g. after a fresh token or a
# new agent build). The installer's systemd path restarts the running unit.
reenroll() {
  need_multipass; resolve_controller_ip
  build_binaries; preflight_controller; resolve_token
  for i in $(seq 1 "$COUNT"); do
    local name="${PREFIX}-${i}"
    multipass info "$name" >/dev/null 2>&1 || continue
    say "[$name] re-enrolling ← ${CONTROLLER_URL}"
    enroll_node "$name" && ok "[$name] re-enrolled." || warn "[$name] failed."
  done
}

status() {
  need_multipass
  multipass list 2>/dev/null | grep -E "Name|^${PREFIX}-" || true
  echo
  for i in $(seq 1 "$COUNT"); do
    local name="${PREFIX}-${i}"
    multipass info "$name" >/dev/null 2>&1 || continue
    printf '\033[1m%s\033[0m: ' "$name"
    guarded 20 multipass exec "$name" -- systemctl is-active swarmy-agent 2>/dev/null \
      || echo "(container backend or unreachable — try: logs $i)"
  done
}

logs() {
  need_multipass
  local name="${PREFIX}-${1:-1}"
  if multipass exec "$name" -- systemctl is-active swarmy-agent >/dev/null 2>&1; then
    multipass exec "$name" -- sudo journalctl -u swarmy-agent -f
  else
    multipass exec "$name" -- sudo docker logs -f swarmy-agent
  fi
}

down() {
  need_multipass
  local names; names="$(multipass list --format csv 2>/dev/null | awk -F, 'NR>1 && $1 ~ /^'"$PREFIX"'-/ {print $1}')"
  [ -n "$names" ] || { warn "No ${PREFIX}-* VMs to remove."; return; }
  say "Deleting: $(echo "$names" | tr '\n' ' ')"
  # shellcheck disable=SC2086
  multipass delete --purge $names
  ok "Removed."
}

case "${1:-up}" in
  up)       up ;;
  reenroll) reenroll ;;
  status)   status ;;
  logs)     shift; logs "${1:-1}" ;;
  down)     down ;;
  *) die "usage: $0 {up|reenroll|status|logs [n]|down}" ;;
esac
