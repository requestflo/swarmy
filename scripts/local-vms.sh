#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
#
# Spin up local Lima VMs as REAL swarmy nodes, enrolled the SAME WAY a
# production box is: the two-stage `curl … | sh` installer downloads the
# Bun-compiled agent binary from your controller, installs it as a systemd
# service, and the node dials home. No Docker image to build or transfer.
#
#   bash scripts/local-vms.sh up        # launch + enroll (default 2 nodes)
#   bash scripts/local-vms.sh status    # Lima state + per-node agent state
#   bash scripts/local-vms.sh logs 1    # follow the agent journal on node 1
#   bash scripts/local-vms.sh reenroll  # re-run the installer on existing VMs
#   bash scripts/local-vms.sh down      # delete + purge all swarmy-node-* VMs
#
# PREREQUISITE: a controller running on this Mac, reachable on your LAN and
# serving the agent binaries. From the repo root:
#     bun run dev:up          # swarm + schema + seed (one time / after resets)
#     bun run build:agent-bin # compile the linux agent binaries (this script also does it)
#     bun dev:app             # controller :3021 + dashboard :3023
# The controller serves binaries automatically once they're built (it looks in
# apps/agent/dist-bin); this script builds them for you and checks reachability.
#
# Tunables (env):
#   SWARMY_VM_COUNT=2            how many VMs
#   SWARMY_VM_CPUS=1             vCPUs per VM
#   SWARMY_VM_MEM=1G             memory per VM (GiB, trailing 'G' optional)
#   SWARMY_VM_DISK=20G           disk per VM (GiB). Only applies when a VM is
#                                 created; `up` warns about smaller existing VMs.
#   SWARMY_VM_JOURNALD_MAX=100M  journald cap written into every VM
#   SWARMY_VM_RELEASE=24.04      Ubuntu release (maps to template:ubuntu-<release>)
#   SWARMY_BACKEND=systemd       agent backend: systemd (native binary) | docker
#   SWARMY_CONTROLLER_IP=…       host IP the VMs dial (default: en0/en1 LAN IP)
#   SWARMY_CONTROLLER_PORT=3021
#   SWARMY_JOIN_TOKEN=…          (default: mint a fresh one via scripts/mint-token.ts)
#   SWARMY_VM_NETWORK=fabric     fabric: vzNAT + lima:user-v2, so VMs reach each other
#                                 (a swarm and its routing mesh without the mesh; needs
#                                 Lima's vz VM type) | slirp: Lima's plain default, every
#                                 VM is 192.168.5.15 and multi-node needs the mesh.
#                                 Applies when a VM is created.
#   SWARMY_VM_BRIDGE=            one more Lima network, e.g. "lima:shared"
#   SWARMY_ALLOW_MESH=           the agent's mesh gate. Unset: true when the minted
#                                 token carries a mesh key, else false.
#   SWARMY_MESH_DRIVER=          e.g. "netbird" — enables mesh for the dev org (see
#                                 docs/LOCAL-SWARM.md). Unset (default): no mesh, VMs
#                                 enroll exactly as before, over LAN.
#   SWARMY_NB_MANAGEMENT_URL=    NetBird Cloud management URL (https://api.netbird.io)
#   SWARMY_NB_SERVICE_TOKEN=     NetBird Personal Access Token (mints setup keys)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

PREFIX="swarmy-node"
COUNT="${SWARMY_VM_COUNT:-2}"
CPUS="${SWARMY_VM_CPUS:-1}"
MEM="${SWARMY_VM_MEM:-1G}"
# 20 GiB: the old 6 GiB (≈4.8 GiB usable) filled up within a test session
# (issues/resolved/vm-disk-chronically-full.md). A worker holds Docker, a
# 2 GiB swap file on a 1 GiB VM, app images and the agent's journal.
DISK="${SWARMY_VM_DISK:-20G}"
JOURNALD_MAX="${SWARMY_VM_JOURNALD_MAX:-100M}"
RELEASE="${SWARMY_VM_RELEASE:-24.04}"
CONTROLLER_PORT="${SWARMY_CONTROLLER_PORT:-3021}"
BACKEND="${SWARMY_BACKEND:-systemd}"
ALLOW_MESH_SET="${SWARMY_ALLOW_MESH:-}"
MESH_DRIVER="${SWARMY_MESH_DRIVER:-}"
NB_MANAGEMENT_URL="${SWARMY_NB_MANAGEMENT_URL:-}"
NB_SERVICE_TOKEN="${SWARMY_NB_SERVICE_TOKEN:-}"

# Lima takes CPU count as int, memory + disk as GiB floats. Strip a trailing
# unit (1G → 1, 1.5G → 1.5) so the env vars stay human-friendly.
MEM_GB="${MEM%G}"; MEM_GB="${MEM_GB%g}"
DISK_GB="${DISK%G}"; DISK_GB="${DISK_GB%g}"

say()  { printf '\033[1;36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

need_lima() {
  command -v limactl >/dev/null 2>&1 || die "Lima not installed (brew install lima)."
  limactl --version >/dev/null 2>&1 || die "limactl not functional."
}

# True (exit 0) if a Lima instance with the given name exists.
vm_exists() {
  limactl list "$1" --quiet >/dev/null 2>&1
}

resolve_controller_ip() {
  HOST_IP="${SWARMY_CONTROLLER_IP:-$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)}"
  [ -n "$HOST_IP" ] || die "Could not determine this Mac's LAN IP. Set SWARMY_CONTROLLER_IP=…"
  CONTROLLER_URL="http://${HOST_IP}:${CONTROLLER_PORT}"
}

# Lima's default user-mode network (slirp) reaches the controller, but gives
# EVERY VM the same address (192.168.5.15) and no path to the other VMs. A
# multi-node swarm can then only form over the mesh, and so can the routing
# mesh: a published port reaches a task on another node over VXLAN (UDP 4789)
# plus gossip (7946). `fabric` (the default) is the e2e harness's layout
# (apps/e2e/cluster/lib/provider.ts): vzNAT gives each VM an address the Mac
# reaches, lima:user-v2 (Lima's virtual switch) carries VM-to-VM traffic, and
# prepare_vm makes user-v2 the default route, so the agent advertises the
# address the other VMs can reach. vzNAT alone is not enough: macOS isolates
# vzNAT guests from each other.
resolve_network() {
  NETWORK_MODE="${SWARMY_VM_NETWORK:-fabric}"
  NETWORK_ARGS=()
  case "$NETWORK_MODE" in
    fabric)
      NETWORK_ARGS=(--network=vzNAT --network=lima:user-v2)
      NET_DESC="vzNAT + lima:user-v2 (VM-to-VM fabric)" ;;
    slirp)
      NET_DESC="default slirp (VMs cannot reach each other: multi-node needs the mesh)" ;;
    *) die "SWARMY_VM_NETWORK must be fabric or slirp (got: ${NETWORK_MODE})" ;;
  esac
  if [ -n "${SWARMY_VM_BRIDGE:-}" ]; then
    NETWORK_ARGS+=(--network "$SWARMY_VM_BRIDGE")
    NET_DESC="${NET_DESC} + ${SWARMY_VM_BRIDGE}"
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

# When SWARMY_MESH_DRIVER/SWARMY_NB_MANAGEMENT_URL/SWARMY_NB_SERVICE_TOKEN are
# set, upsert the dev org's MeshConfig (scripts/seed-dev.ts's ensureMeshConfig)
# before minting a token, so the mint below picks up an embedded NetBird setup
# key. No-op — and no behavior change — when SWARMY_MESH_DRIVER is unset.
ensure_mesh_seed() {
  [ -n "$MESH_DRIVER" ] || return 0
  say "Enabling mesh (${MESH_DRIVER}) for the dev org…"
  SWARMY_MESH_DRIVER="$MESH_DRIVER" \
    SWARMY_NB_MANAGEMENT_URL="$NB_MANAGEMENT_URL" \
    SWARMY_NB_SERVICE_TOKEN="$NB_SERVICE_TOKEN" \
    bun --env-file=.env run scripts/seed-dev.ts >/dev/null
  ok "Mesh config applied."
}

# Sets TOKEN, and (only when mesh is enabled for the org) MESH_SETUP_KEY /
# MESH_MANAGEMENT_URL / MESH_DRIVER_OUT from scripts/mint-token.ts's
# `KEY=value` stdout lines.
resolve_token() {
  MESH_SETUP_KEY=""
  MESH_MANAGEMENT_URL=""
  MESH_DRIVER_OUT=""
  if [ -n "${SWARMY_JOIN_TOKEN:-}" ]; then
    TOKEN="$SWARMY_JOIN_TOKEN"; resolve_allow_mesh; return
  fi
  say "Minting a fresh join token…"
  local out
  out="$(bun --env-file=.env run scripts/mint-token.ts 2>/dev/null)"
  TOKEN="$(printf '%s\n' "$out" | sed -n 's/^TOKEN=//p' | tr -d '[:space:]')"
  MESH_SETUP_KEY="$(printf '%s\n' "$out" | sed -n 's/^MESH_SETUP_KEY=//p' | tr -d '[:space:]')"
  MESH_MANAGEMENT_URL="$(printf '%s\n' "$out" | sed -n 's/^MESH_MANAGEMENT_URL=//p' | tr -d '[:space:]')"
  MESH_DRIVER_OUT="$(printf '%s\n' "$out" | sed -n 's/^MESH_DRIVER=//p' | tr -d '[:space:]')"
  [ -n "$TOKEN" ] || die "Could not mint a join token. Run 'bun run dev:up' first (seeds the dev org)."
  [ -z "$MESH_SETUP_KEY" ] || ok "Join token embeds a NetBird setup key (${MESH_DRIVER_OUT}) — single-use."
  resolve_allow_mesh
}

# The agent ignores a mesh key unless SWARMY_ALLOW_MESH=true. Defaulting it to
# false while handing out a key left nodes with no mesh client and no error
# (issues/manual-recovery-required-not-magical.md item 5): unset now follows
# the key; an explicit false still wins, loudly.
resolve_allow_mesh() {
  if [ -n "$ALLOW_MESH_SET" ]; then
    ALLOW_MESH="$ALLOW_MESH_SET"
    if [ -n "$MESH_SETUP_KEY" ] && [ "$ALLOW_MESH" != true ]; then
      warn "SWARMY_ALLOW_MESH=${ALLOW_MESH}: the agents will ignore the minted mesh key (no mesh client)."
    fi
  elif [ -n "$MESH_SETUP_KEY" ]; then
    ALLOW_MESH=true
  else
    ALLOW_MESH=false
  fi
}

# A token that carries a mesh key is single-use (maxUses=1, and so is the
# NetBird key), so every VM after the first needs its own. A token passed in
# with SWARMY_JOIN_TOKEN is used as given.
token_for_next_node() {
  if [ -n "${TOKEN_SPENT:-}" ] && [ -n "$MESH_SETUP_KEY" ] && [ -z "${SWARMY_JOIN_TOKEN:-}" ]; then
    resolve_token
  fi
  TOKEN_SPENT=1
}

# Run a command with a hard wall-clock cap (macOS has no `timeout`).
# Turns an indefinite hang into a recoverable failure. The watchdog's stdio is
# /dev/null: its `sleep` outlives the kill below, and while it held the
# terminal's stdout, `local-vms.sh up | tee log` waited out every timeout.
guarded() {
  local secs="$1"; shift
  ( "$@" & local p=$!
    ( sleep "$secs"; kill -9 "$p" 2>/dev/null ) </dev/null >/dev/null 2>&1 & local k=$!
    wait "$p"; local rc=$?; kill "$k" 2>/dev/null; return "$rc" )
}

# Keep a long-lived test VM's disk from filling up (vm-disk-chronically-full):
# a journald cap, no cached .debs after apt runs, no kernel-header trees from
# kernel updates, and old kernels autoremoved. Idempotent; runs as root on the
# VM before every (re-)enroll. Docker images are the agent's job: the
# controller's node-hygiene worker prunes them (apps/api/src/workers/node-hygiene.ts).
# (A function, not $(cat <<…): macOS bash 3.2 mis-parses quotes in a here-doc
# inside a command substitution.)
prepare_vm_script() {
  cat <<'SWARMY_PREPARE_EOF'
set -u
# journald: zz- sorts after the installer's swarmy.conf (500M), so this wins.
mkdir -p /etc/systemd/journald.conf.d
jf=/etc/systemd/journald.conf.d/zz-swarmy-vm.conf
printf '[Journal]\nSystemMaxUse=%s\n' "$JOURNALD_MAX" > "$jf.new"
if cmp -s "$jf.new" "$jf"; then rm -f "$jf.new"; else mv "$jf.new" "$jf"; systemctl restart systemd-journald || true; fi
journalctl --vacuum-size="$JOURNALD_MAX" >/dev/null 2>&1 || true

# apt: never keep downloaded packages (the same rule Docker's ubuntu image uses).
cat > /etc/apt/apt.conf.d/99-swarmy-vm <<'EOF'
// scripts/local-vms.sh: a test VM keeps no downloaded .debs.
APT::Keep-Downloaded-Packages "false";
Binary::apt::APT::Keep-Downloaded-Packages "false";
DPkg::Post-Invoke { "rm -f /var/cache/apt/archives/*.deb /var/cache/apt/archives/partial/*.deb 2>/dev/null || true"; };
EOF

# Kernel headers: nothing on a test VM builds kernel modules, so dpkg skips
# the header trees every kernel update would add (package state is untouched).
cat > /etc/dpkg/dpkg.cfg.d/99-swarmy-vm <<'EOF'
# scripts/local-vms.sh: never unpack kernel header trees on a test VM.
path-exclude=/usr/src/linux-headers-*
EOF
rm -rf /usr/src/linux-headers-*

# Old kernels + the apt cache. Bounded: on first boot unattended-upgrades may
# hold the dpkg lock, and the next enroll tries again.
apt-get -qq -o DPkg::Lock::Timeout=60 autoremove --purge -y >/dev/null 2>&1 || true
apt-get -qq clean >/dev/null 2>&1 || true
df -h / | awk 'NR == 2 { print "    disk: " $3 " used, " $4 " free (" $5 " full)" }'

# Network fabric (SWARMY_VM_NETWORK=fabric): user-v2 (eth0) becomes the
# default route, so the address the agent advertises to the swarm (its route
# toward the controller) is the one the other VMs reach. The Mac's DHCP search
# domain is dropped too: Docker copies it into every container, and busybox
# nslookup of a bare service name then fails. Same steps as the e2e harness.
[ "$VM_NETWORK" = fabric ] || exit 0
np=/etc/netplan/50-cloud-init.yaml
if ip -4 -o addr show dev eth0 2>/dev/null | grep -q ' 192\.168\.5\.15/' || ! ip link show lima0 >/dev/null 2>&1; then
  echo "    network: WARNING: this VM was created without the fabric (plain slirp). For a multi-node swarm without the mesh, recreate it (down, then up)."
  exit 0
fi
if [ -f "$np" ] && ! grep -q 'use-domains: false' "$np"; then
  # eth0 carries Lima's user-network metric (200), lima0 the vmnet one (100).
  # use-domains goes under each route-metric, at that line's indentation.
  sed -i -e '0,/route-metric: 200/s//route-metric: 50/' -e 's/^\([[:space:]]*\)route-metric:.*$/&\n\1use-domains: false/' "$np"
  netplan apply 2>/dev/null || true
fi
# netplan apply briefly drops the routes; wait for DHCP to put them back.
for _ in $(seq 1 30); do ip -4 route get 1.1.1.1 2>/dev/null | grep -q 'dev eth0' && break; sleep 1; done
if ip -4 route get 1.1.1.1 2>/dev/null | grep -q 'dev eth0'; then
  echo "    network: swarm fabric on eth0 $(ip -4 -o addr show dev eth0 | awk '{print $4}' | cut -d/ -f1) (default route)"
else
  echo "    network: WARNING: the default route is not the user-v2 fabric ($(ip -4 route get 1.1.1.1 2>/dev/null | grep -o 'dev [a-z0-9]*')). The swarm may advertise an address the other VMs cannot reach."
fi
SWARMY_PREPARE_EOF
}

prepare_vm() {
  local name="$1"
  say "[$name] VM hygiene: journald ≤ ${JOURNALD_MAX}, no apt cache, no kernel headers"
  guarded 180 limactl shell --workdir / "$name" -- sudo env JOURNALD_MAX="$JOURNALD_MAX" VM_NETWORK="$NETWORK_MODE" \
    bash -c "$(prepare_vm_script)" \
    || warn "[$name] VM hygiene step failed (continuing)."
}

# A VM's disk size is fixed when it is created: say so when an existing one is
# smaller than asked for. Lima reports the disk in bytes.
check_vm_disk() {
  local name="$1" have
  have="$(limactl list "$name" --format '{{.Disk}}' 2>/dev/null | awk '{ if ($1 ~ /^[0-9]+$/) printf "%.1f", $1 / 1073741824 }')"
  [ -n "$have" ] || return 0
  if awk -v h="$have" -v w="$DISK_GB" 'BEGIN { exit !(h + 0.5 < w) }'; then
    warn "[$name] has a ${have} GiB disk (SWARMY_VM_DISK asks for ${DISK_GB} GiB). Disk size is set at creation: recreate it with 'bash scripts/local-vms.sh down' then 'up'."
  fi
}

# Run the SAME one-liner the dashboard hands out, on a VM. `--controller`
# makes the loader derive every later URL (installer, agent binary, dial-back)
# from the LAN controller address, whatever CONTROLLER_PUBLIC_URL it bakes.
# The loader sha256-verifies the installer; the installer verifies the binary.
enroll_node() {
  local name="$1"
  local mesh_env=()
  if [ -n "${MESH_SETUP_KEY:-}" ]; then
    mesh_env=(
      SWARMY_MESH_SETUP_KEY="$MESH_SETUP_KEY"
      SWARMY_MESH_MANAGEMENT_URL="$MESH_MANAGEMENT_URL"
      SWARMY_MESH_DRIVER="$MESH_DRIVER_OUT"
    )
  fi
  guarded 300 limactl shell "$name" -- sudo env \
    SWARMY_JOIN_TOKEN="$TOKEN" \
    SWARMY_BACKEND="$BACKEND" \
    SWARMY_NODE_LABELS="local-vm,${name}" \
    SWARMY_ALLOW_MESH="$ALLOW_MESH" \
    ${mesh_env[@]+"${mesh_env[@]}"} \
    bash -c "curl -fsSL '${CONTROLLER_URL}/install/loader.sh' | sh -s -- --controller '${CONTROLLER_URL}'"
}

up() {
  need_lima; resolve_controller_ip; resolve_network
  build_binaries; preflight_controller; ensure_mesh_seed; resolve_token

  if [ "$NETWORK_MODE" = slirp ] && [ "$COUNT" -gt 1 ] && [ -z "${MESH_SETUP_KEY:-}" ]; then
    warn "SWARMY_VM_NETWORK=slirp with ${COUNT} VMs and no mesh: every VM gets the same address, so they cannot form one swarm. Use the default fabric or a mesh."
  fi
  say "Launching ${COUNT} × Ubuntu ${RELEASE} (${CPUS} CPU / ${MEM} / ${DISK}) — ${NET_DESC}"
  printf '    controller : %s\n    backend    : %s\n    join token : %s…\n\n' \
    "$CONTROLLER_URL" "$BACKEND" "${TOKEN:0:14}"

  for i in $(seq 1 "$COUNT"); do
    local name="${PREFIX}-${i}"
    if vm_exists "$name"; then
      warn "[$name] exists — ensuring it's running, then re-running the installer (idempotent)."
      limactl start --tty=false "$name" >/dev/null 2>&1 || true
      check_vm_disk "$name"
    else
      say "[$name] launching…"
      # --containerd=none: Docker is the engine here; Lima's default rootless
      # containerd + nerdctl would only cost disk and memory.
      limactl start --tty=false --timeout=10m \
        --name="$name" \
        --cpus="$CPUS" --memory="$MEM_GB" --disk="$DISK_GB" \
        --containerd=none \
        ${NETWORK_ARGS[@]+"${NETWORK_ARGS[@]}"} \
        "template:ubuntu-${RELEASE}"
    fi
    prepare_vm "$name"
    token_for_next_node
    say "[$name] installing agent (${BACKEND}) ← ${CONTROLLER_URL}"
    if enroll_node "$name"; then
      ok "[$name] agent installed — should reach ONLINE shortly."
    else
      warn "[$name] install hung/failed. Recover: limactl restart $name && bash scripts/local-vms.sh reenroll"
    fi
  done

  echo; ok "Done. Dashboard → Infrastructure; ${COUNT} node(s) should go ONLINE within seconds."
  say "Tail an agent:  bash scripts/local-vms.sh logs 1"
}

# Re-run the installer on already-launched VMs (e.g. after a fresh token or a
# new agent build). The installer's systemd path restarts the running unit.
reenroll() {
  need_lima; resolve_controller_ip; resolve_network
  build_binaries; preflight_controller; ensure_mesh_seed; resolve_token
  for i in $(seq 1 "$COUNT"); do
    local name="${PREFIX}-${i}"
    vm_exists "$name" || continue
    check_vm_disk "$name"
    prepare_vm "$name"
    token_for_next_node
    say "[$name] re-enrolling ← ${CONTROLLER_URL}"
    enroll_node "$name" && ok "[$name] re-enrolled." || warn "[$name] failed."
  done
}

status() {
  need_lima
  limactl list 2>/dev/null | awk 'NR==1 || /^'"$PREFIX"'-/' || true
  echo
  for i in $(seq 1 "$COUNT"); do
    local name="${PREFIX}-${i}"
    vm_exists "$name" || continue
    printf '\033[1m%s\033[0m: ' "$name"
    guarded 20 limactl shell "$name" -- systemctl is-active swarmy-agent 2>/dev/null \
      || echo "(container backend or unreachable — try: logs $i)"
  done
}

logs() {
  need_lima
  local name="${PREFIX}-${1:-1}"
  if limactl shell "$name" -- systemctl is-active swarmy-agent >/dev/null 2>&1; then
    limactl shell "$name" -- sudo journalctl -u swarmy-agent -f
  else
    limactl shell "$name" -- sudo docker logs -f swarmy-agent
  fi
}

down() {
  need_lima
  local names; names="$(limactl list --quiet 2>/dev/null | grep "^${PREFIX}-" || true)"
  [ -n "$names" ] || { warn "No ${PREFIX}-* VMs to remove."; return; }
  say "Deleting: $(echo "$names" | tr '\n' ' ')"
  # shellcheck disable=SC2086
  limactl delete --force $names
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
