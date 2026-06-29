#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
#
# Spin up a few local multipass VMs as REAL swarmy nodes that join the
# controller running on this Mac. Each VM gets Docker + a single-node swarm,
# then runs the swarmy agent (built locally — no registry needed) which dials
# the controller over the WebSocket gateway. Watch them flip to ONLINE on the
# Infrastructure plane.
#
#   bash scripts/local-vms.sh up        # launch (default 3 nodes)
#   bash scripts/local-vms.sh status    # multipass list + per-node agent state
#   bash scripts/local-vms.sh logs 1    # tail agent logs on swarmy-node-1
#   bash scripts/local-vms.sh down      # delete + purge all swarmy-node-* VMs
#
# Tunables (env):
#   SWARMY_VM_COUNT=3            how many VMs
#   SWARMY_VM_CPUS=1 MEM=1G DISK=5G
#   SWARMY_VM_RELEASE=24.04      Ubuntu release
#   SWARMY_CONTROLLER_IP=…       host IP the VMs dial (default: en0 LAN IP)
#   SWARMY_CONTROLLER_PORT=3001
#   SWARMY_JOIN_TOKEN=…          (default: .swarmy-dev-token)
#   SWARMY_VM_BRIDGE=en0         bridge VMs onto your LAN (same IP range) instead
#                                of NAT. Auto-used if en0 is bridgeable.
#   SWARMY_ALLOW_MESH=false      agent capability flags (off by default here)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

PREFIX="swarmy-node"
IMAGE_TAG="swarmy-agent:local"
IMAGE_TAR="/tmp/swarmy-agent-local.tar"

COUNT="${SWARMY_VM_COUNT:-3}"
CPUS="${SWARMY_VM_CPUS:-1}"
MEM="${SWARMY_VM_MEM:-1G}"
DISK="${SWARMY_VM_DISK:-5G}"
RELEASE="${SWARMY_VM_RELEASE:-24.04}"
CONTROLLER_PORT="${SWARMY_CONTROLLER_PORT:-3001}"
ALLOW_MESH="${SWARMY_ALLOW_MESH:-false}"
ALLOW_BUILD="${SWARMY_ALLOW_BUILD:-false}"
ALLOW_EXEC="${SWARMY_ALLOW_EXEC:-false}"

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
  WS_URL="ws://${HOST_IP}:${CONTROLLER_PORT}/agent/ws"
}

resolve_token() {
  TOKEN="${SWARMY_JOIN_TOKEN:-$(tr -d '[:space:]' < .swarmy-dev-token 2>/dev/null || true)}"
  [ -n "$TOKEN" ] || die "No join token. Run 'bun run dev:up' (writes .swarmy-dev-token) or set SWARMY_JOIN_TOKEN=…"
}

# Pick a bridged LAN interface if one is available (so VMs share the Mac's IP
# range), otherwise fall back to NAT (still reaches the controller via HOST_IP).
resolve_network() {
  local want="${SWARMY_VM_BRIDGE:-en0}"
  NETWORK_ARGS=()
  if multipass networks 2>/dev/null | awk 'NR>1{print $1}' | grep -qx "$want"; then
    NETWORK_ARGS=(--network "name=${want},mode=auto")
    NET_DESC="bridged via ${want} (LAN IP range)"
  else
    NET_DESC="NAT (reaches controller at ${HOST_IP})"
  fi
}

cloud_init_file() {
  # Docker from Ubuntu's repo; add the default user to the docker group.
  cat <<'YAML'
#cloud-config
package_update: true
packages:
  - docker.io
runcmd:
  - [ systemctl, enable, --now, docker ]
  - [ usermod, -aG, docker, ubuntu ]
YAML
}

vm_ip() { multipass exec "$1" -- bash -lc "hostname -I | awk '{print \$1}'" 2>/dev/null | tr -d '\r'; }

# Wait for Docker to be installed and responsive. We poll `docker info` directly
# rather than `cloud-init status --wait`, which is known to hang on Ubuntu 24.04
# under multipass even after cloud-init has actually finished.
wait_for_docker() {
  local name="$1" tries=0
  until multipass exec "$name" -- sudo docker info >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -gt 90 ]; then   # ~7.5 min
      die "[$name] Docker did not become ready. Check: multipass exec $name -- cloud-init status --long"
    fi
    sleep 5
  done
}

up() {
  need_multipass; resolve_controller_ip; resolve_token; resolve_network

  docker image inspect "$IMAGE_TAG" >/dev/null 2>&1 || die "Image $IMAGE_TAG not found. Build it:
    docker build -t $IMAGE_TAG --build-arg SWARMY_COMMIT=\$(git rev-parse --short HEAD) -f apps/agent/Dockerfile ."
  say "Refreshing image tar ($IMAGE_TAR)…"
  docker save "$IMAGE_TAG" -o "$IMAGE_TAR"

  # Make sure the controller is actually reachable from where the VMs will dial.
  if ! curl -fsS -o /dev/null --max-time 4 "http://${HOST_IP}:${CONTROLLER_PORT}/install.sh"; then
    warn "Controller not answering at http://${HOST_IP}:${CONTROLLER_PORT} — is 'bun dev' running? Continuing anyway."
  fi

  say "Launching ${COUNT} × Ubuntu ${RELEASE} (${CPUS} CPU / ${MEM} / ${DISK}) — ${NET_DESC}"
  printf '    controller : %s\n    join token : %s…\n\n' "$WS_URL" "${TOKEN:0:12}"

  local ci; ci="$(mktemp -t swarmy-ci)"; cloud_init_file >"$ci"
  trap 'rm -f "$ci"' RETURN

  for i in $(seq 1 "$COUNT"); do
    local name="${PREFIX}-${i}"
    if multipass info "$name" >/dev/null 2>&1; then
      warn "$name already exists — skipping launch (use 'down' to reset)."
    else
      say "[$name] launching…"
      multipass launch "$RELEASE" --name "$name" \
        --cpus "$CPUS" --memory "$MEM" --disk "$DISK" \
        --cloud-init "$ci" "${NETWORK_ARGS[@]}"
    fi

    say "[$name] waiting for Docker to be ready…"
    wait_for_docker "$name"

    local ip; ip="$(vm_ip "$name")"
    say "[$name] enabling single-node swarm (advertise ${ip})…"
    multipass exec "$name" -- sudo docker swarm init --advertise-addr "$ip" >/dev/null 2>&1 \
      || multipass exec "$name" -- sudo docker swarm init --advertise-addr "${ip}:2377" >/dev/null 2>&1 || true

    say "[$name] loading agent image…"
    multipass transfer "$IMAGE_TAR" "${name}:/tmp/agent.tar"
    multipass exec "$name" -- sudo docker load -i /tmp/agent.tar >/dev/null

    say "[$name] starting swarmy agent → ${WS_URL}"
    multipass exec "$name" -- sudo docker rm -f swarmy-agent >/dev/null 2>&1 || true
    multipass exec "$name" -- sudo docker run -d \
      --name swarmy-agent --restart unless-stopped \
      -v /var/run/docker.sock:/var/run/docker.sock \
      -v swarmy-agent:/var/lib/swarmy \
      -e AGENT_WS_URL="$WS_URL" \
      -e SWARMY_JOIN_TOKEN="$TOKEN" \
      -e SWARMY_NODE_LABELS="local-vm,${name}" \
      -e SWARMY_ALLOW_MESH="$ALLOW_MESH" \
      -e SWARMY_ALLOW_BUILD="$ALLOW_BUILD" \
      -e SWARMY_ALLOW_EXEC="$ALLOW_EXEC" \
      -e SWARMY_AGENT_STATE=/var/lib/swarmy/agent.json \
      "$IMAGE_TAG" >/dev/null
    ok "[$name] agent up"
  done

  echo
  ok "Done. Open the dashboard → Infrastructure; ${COUNT} nodes should go ONLINE shortly."
  say "Tail an agent:  bash scripts/local-vms.sh logs 1"
}

status() {
  need_multipass
  multipass list 2>/dev/null | grep -E "Name|^${PREFIX}-" || true
  echo
  for i in $(seq 1 "$COUNT"); do
    local name="${PREFIX}-${i}"
    multipass info "$name" >/dev/null 2>&1 || continue
    printf '\033[1m%s\033[0m: ' "$name"
    multipass exec "$name" -- sudo docker ps --filter name=swarmy-agent \
      --format '{{.Status}}' 2>/dev/null || echo "(unreachable)"
  done
}

logs() {
  need_multipass
  local name="${PREFIX}-${1:-1}"
  multipass exec "$name" -- sudo docker logs -f swarmy-agent
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
  up)     up ;;
  status) status ;;
  logs)   shift; logs "${1:-1}" ;;
  down)   down ;;
  *) die "usage: $0 {up|status|logs [n]|down}" ;;
esac
