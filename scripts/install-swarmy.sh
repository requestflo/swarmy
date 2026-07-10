#!/usr/bin/env bash
#
# install-swarmy.sh — stand up a self-hosted swarmy control plane on a fresh VPS.
#
#   curl -fsSL https://get.swarmy.dev | bash
#   # or, from a checkout:
#   bash scripts/install-swarmy.sh
#
# This is NOT the agent enrol flow (that joins a node to an existing controller).
# This bootstraps swarmy itself from zero: install Docker, init a one-node Swarm,
# deploy the controller (which bundles the dashboard) + optional Postgres, seed the
# owner + a join token + the SwarmConfig, and enrol THIS host as node #1. Networking
# (mesh) and public ingress are optional and off by default.
#
# Every phase is marker-gated in $STATE_DIR/state.env, so the whole script is safe
# to re-run: it converges instead of duplicating. Secrets are generated ONCE and
# reused — regenerating SWARMY_SECRET_KEY would orphan the encrypted vault forever.
#
# Flags / env (flags win; env is the non-interactive path):
#   --non-interactive            never prompt; use flags/env/defaults
#   --check                      preflight only — detect + report, mutate nothing
#   --uninstall                  remove the swarmy stack, secrets, and node #1 agent
#   --standard                   Postgres tier (default: lite/embedded PGlite)
#   --admin-email <e>            SWARMY_ADMIN_EMAIL
#   --admin-password <p>         SWARMY_ADMIN_PASSWORD   (generated if unset)
#   --domain <host>              SWARMY_DOMAIN           (enables ingress prompts)
#   --ingress none|caddy|cloudflare        SWARMY_INGRESS
#   --mesh none|netbird-cloud|netbird-external   SWARMY_MESH
#   --image <ref>                SWARMY_IMAGE       (controller image)
#   --agent-image <ref>          SWARMY_AGENT_IMAGE
#   --port <n>                   SWARMY_PUBLISH_PORT (default 3001)
# Cloudflare (when --ingress cloudflare): CF_API_TOKEN, CF_ACCOUNT_ID, CF_ZONE_ID
# NetBird (when --mesh netbird-*):        NB_SERVICE_TOKEN, NB_MANAGEMENT_URL
set -euo pipefail

# ── constants ───────────────────────────────────────────────────────────────
DEFAULT_IMAGE="ghcr.io/requestflo/swarmy-controller:latest"
DEFAULT_AGENT_IMAGE="ghcr.io/requestflo/swarmy-agent:latest"
STACK_NAME="swarmy"
STATE_DIR="/var/lib/swarmy/install"
STATE_FILE="$STATE_DIR/state.env"
OVERLAY_NET="${STACK_NAME}_swarmy"            # docker stack prefixes the network name
CONTROLLER_DNS="swarmy_controller:3001"        # service name on the overlay
AGENT_CONTAINER="swarmy-agent"

# ── logging ─────────────────────────────────────────────────────────────────
c_blue=''; c_green=''; c_yellow=''; c_red=''; c_dim=''; c_reset=''
if [ -t 1 ]; then
  c_blue=$'\033[34m'; c_green=$'\033[32m'; c_yellow=$'\033[33m'; c_red=$'\033[31m'; c_dim=$'\033[2m'; c_reset=$'\033[0m'
fi
say()  { printf '%s\n' "${c_blue}▸${c_reset} $*"; }
ok()   { printf '%s\n' "${c_green}✓${c_reset} $*"; }
warn() { printf '%s\n' "${c_yellow}!${c_reset} $*" >&2; }
die()  { printf '%s\n' "${c_red}✗${c_reset} $*" >&2; exit 1; }
hr()   { printf '%s\n' "${c_dim}────────────────────────────────────────────────────────${c_reset}"; }

# ── config (env defaults; flags override below) ─────────────────────────────
NON_INTERACTIVE="${SWARMY_NON_INTERACTIVE:-0}"
MODE="install"
DB_TIER="${SWARMY_DB_TIER:-lite}"
ADMIN_EMAIL="${SWARMY_ADMIN_EMAIL:-}"
ADMIN_PASSWORD="${SWARMY_ADMIN_PASSWORD:-}"
DOMAIN="${SWARMY_DOMAIN:-}"
INGRESS="${SWARMY_INGRESS:-none}"
MESH="${SWARMY_MESH:-none}"
IMAGE="${SWARMY_IMAGE:-$DEFAULT_IMAGE}"
AGENT_IMAGE="${SWARMY_AGENT_IMAGE:-$DEFAULT_AGENT_IMAGE}"
PUBLISH_PORT="${SWARMY_PUBLISH_PORT:-3001}"

while [ $# -gt 0 ]; do
  case "$1" in
    --non-interactive) NON_INTERACTIVE=1 ;;
    --check) MODE="check" ;;
    --uninstall) MODE="uninstall" ;;
    --standard) DB_TIER="standard" ;;
    --admin-email) ADMIN_EMAIL="${2:?}"; shift ;;
    --admin-password) ADMIN_PASSWORD="${2:?}"; shift ;;
    --domain) DOMAIN="${2:?}"; shift ;;
    --ingress) INGRESS="${2:?}"; shift ;;
    --mesh) MESH="${2:?}"; shift ;;
    --image) IMAGE="${2:?}"; shift ;;
    --agent-image) AGENT_IMAGE="${2:?}"; shift ;;
    --port) PUBLISH_PORT="${2:?}"; shift ;;
    -h|--help) grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done

# ── state helpers ───────────────────────────────────────────────────────────
# shellcheck source=/dev/null
state_load() { [ -f "$STATE_FILE" ] && . "$STATE_FILE" || true; }
state_set() {  # state_set KEY VALUE  — persist (and export) a value, replacing any prior.
  local key="$1" val="$2"
  mkdir -p "$STATE_DIR"; touch "$STATE_FILE"; chmod 600 "$STATE_FILE"
  grep -v "^${key}=" "$STATE_FILE" > "${STATE_FILE}.tmp" 2>/dev/null || true
  printf '%s=%q\n' "$key" "$val" >> "${STATE_FILE}.tmp"
  mv "${STATE_FILE}.tmp" "$STATE_FILE"; chmod 600 "$STATE_FILE"
  export "$key=$val"
}
marker_done() { state_load; local v; eval "v=\${MARK_$1:-}"; [ "$v" = "1" ]; }
marker_set()  { state_set "MARK_$1" 1; }

need_root() {
  [ "$(id -u)" -eq 0 ] || die "run as root (or via sudo): this installs Docker, inits a Swarm, and writes $STATE_DIR."
}

# ════════════════════════════════════════════════════════════════════════════
# Phase 1 — preflight & discovery (read-only)
# ════════════════════════════════════════════════════════════════════════════
PUBLIC_IP=""; LOCAL_IP=""; NAT_VERDICT=""
discover() {
  say "Preflight & discovery…"
  case "$(uname -s)" in Linux) : ;; *) die "self-host requires Linux (got $(uname -s))." ;; esac

  LOCAL_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
  [ -n "$LOCAL_IP" ] || LOCAL_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [ -n "$LOCAL_IP" ] || warn "could not determine a local routable IP."

  # Public IP: majority vote across independent echo services (best-effort).
  local ips a b c
  a="$(curl -fsS -m 4 https://api.ipify.org 2>/dev/null || true)"
  b="$(curl -fsS -m 4 https://icanhazip.com 2>/dev/null | tr -d '[:space:]' || true)"
  c="$(curl -fsS -m 4 https://ifconfig.me 2>/dev/null || true)"
  ips="$(printf '%s\n%s\n%s\n' "$a" "$b" "$c" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || true)"
  PUBLIC_IP="$(printf '%s\n' "$ips" | sort | uniq -c | sort -rn | awk 'NR==1{print $2}')"

  if [ -z "$PUBLIC_IP" ]; then
    NAT_VERDICT="unknown"; warn "public IP undetermined (no egress to IP echo services?)."
  elif [ "$PUBLIC_IP" = "$LOCAL_IP" ]; then
    NAT_VERDICT="bound"
  elif printf '%s' "$LOCAL_IP" | grep -qE '^100\.6[4-9]\.|^100\.[7-9][0-9]\.|^100\.1[01][0-9]\.|^100\.12[0-7]\.'; then
    NAT_VERDICT="cgnat"
  else
    NAT_VERDICT="nat"
  fi
  ok "local IP ${LOCAL_IP:-?}; public IP ${PUBLIC_IP:-?}; network: ${NAT_VERDICT}."
}

# ════════════════════════════════════════════════════════════════════════════
# Phase 2 — egress gate (mandatory; everything downstream pulls images)
# ════════════════════════════════════════════════════════════════════════════
egress_gate() {
  say "Checking internet egress…"
  local hosts="ghcr.io registry-1.docker.io"
  command -v docker >/dev/null 2>&1 || hosts="$hosts get.docker.com"
  local h
  for h in $hosts; do
    curl -fsS -m 6 -o /dev/null "https://$h" 2>/dev/null \
      || die "no egress to https://$h — swarmy needs to pull images. Fix outbound networking and re-run."
  done
  ok "egress reachable: $hosts."
}

# ════════════════════════════════════════════════════════════════════════════
# Phase 3 — Docker
# ════════════════════════════════════════════════════════════════════════════
ensure_docker() {
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    ok "Docker present ($(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?'))."
    return
  fi
  say "Installing Docker via get.docker.com…"
  curl -fsSL https://get.docker.com | sh || die "Docker install failed."
  docker info >/dev/null 2>&1 || die "Docker installed but the daemon is not responding."
  ok "Docker installed."
}

# ════════════════════════════════════════════════════════════════════════════
# Phase 4 — interactive wizard (collect config)
# ════════════════════════════════════════════════════════════════════════════
prompt()      { local q="$1" d="${2:-}" a; if [ "$NON_INTERACTIVE" = 1 ]; then printf '%s' "$d"; return; fi
                read -r -p "$(printf '%s%s: ' "$q" "${d:+ [$d]}")" a </dev/tty || true; printf '%s' "${a:-$d}"; }
prompt_secret(){ local q="$1" a; if [ "$NON_INTERACTIVE" = 1 ]; then printf ''; return; fi
                read -r -s -p "$q: " a </dev/tty || true; printf '\n' >&2; printf '%s' "$a"; }
choose()      { # choose VAR "prompt" opt1 opt2 ...  → echoes chosen value
                local q="$1"; shift; local def="$1"; shift
                if [ "$NON_INTERACTIVE" = 1 ]; then printf '%s' "$def"; return; fi
                printf '%s\n' "$q" >&2; local i=1 o
                for o in "$@"; do printf '  %d) %s%s\n' "$i" "$o" "$([ "$o" = "$def" ] && printf ' (default)')" >&2; i=$((i+1)); done
                local sel; read -r -p "choice [${def}]: " sel </dev/tty || true
                if [ -z "$sel" ]; then printf '%s' "$def"; return; fi
                case "$sel" in ''|*[!0-9]*) printf '%s' "$sel" ;; *) eval "printf '%s' \"\${$sel}\"" 2>/dev/null || printf '%s' "$def" ;; esac }

wizard() {
  hr; say "Configuration"
  [ -n "$ADMIN_EMAIL" ] || ADMIN_EMAIL="$(prompt 'Admin email' 'admin@localhost')"
  if [ -z "$ADMIN_PASSWORD" ]; then
    ADMIN_PASSWORD="$(prompt_secret 'Admin password (blank = generate)')"
    [ -n "$ADMIN_PASSWORD" ] || { ADMIN_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"; GENERATED_PW=1; }
  fi

  if [ "$NON_INTERACTIVE" != 1 ] && [ "$DB_TIER" = lite ]; then
    case "$(choose 'Datastore tier' lite lite standard)" in standard) DB_TIER=standard ;; esac
  fi

  # Ingress — recommend based on detected reachability.
  if [ "$INGRESS" = none ] && [ "$NON_INTERACTIVE" != 1 ]; then
    local rec=none
    case "$NAT_VERDICT" in bound) rec=caddy ;; nat|cgnat|unknown) rec=cloudflare ;; esac
    say "Network looks '${NAT_VERDICT}'. Suggested public ingress: ${rec} (or 'none' = reach via http://${PUBLIC_IP:-<ip>}:${PUBLISH_PORT})."
    INGRESS="$(choose 'Public ingress for the dashboard' "$rec" none caddy cloudflare)"
  fi
  if [ "$INGRESS" != none ] && [ -z "$DOMAIN" ]; then DOMAIN="$(prompt 'Domain (e.g. swarmy.example.com)')"; fi
  if [ "$INGRESS" = cloudflare ]; then
    CF_API_TOKEN="${CF_API_TOKEN:-$(prompt_secret 'Cloudflare API token (Account:Cloudflare Tunnel:Edit + Zone:DNS:Edit')}"
    CF_ACCOUNT_ID="${CF_ACCOUNT_ID:-$(prompt 'Cloudflare account id')}"
    CF_ZONE_ID="${CF_ZONE_ID:-$(prompt 'Cloudflare zone id')}"
  fi

  # Mesh — none by default; keep managed-in-swarm out of v1.
  if [ "$MESH" = none ] && [ "$NON_INTERACTIVE" != 1 ]; then
    MESH="$(choose 'Overlay mesh (for adding remote nodes later)' none none netbird-cloud netbird-external)"
  fi
  if [ "$MESH" = netbird-cloud ] || [ "$MESH" = netbird-external ]; then
    if [ "$MESH" = netbird-external ]; then
      NB_MANAGEMENT_URL="${NB_MANAGEMENT_URL:-$(prompt 'NetBird management URL')}"
    else
      NB_MANAGEMENT_URL="${NB_MANAGEMENT_URL:-$(prompt 'NetBird management URL' 'https://api.netbird.io')}"
    fi
    # A Personal Access Token (Settings → Personal Access Tokens), NOT a one-time
    # setup key — the controller uses it to mint a fresh single-use setup key per
    # node via the Admin API (mintSetupKeyForOrg), so every "Add a node" one-liner
    # gets its own key instead of operators sharing one across nodes.
    NB_SERVICE_TOKEN="${NB_SERVICE_TOKEN:-$(prompt_secret 'NetBird API access token (Personal Access Token)')}"
  fi

  # First login always happens over the host IP:port — ingress is applied later in
  # the dashboard. Auth (BETTER_AUTH_URL/CONTROLLER_PUBLIC_URL) MUST match the origin
  # the browser uses or sign-in fails CSRF, so pin it to LOGIN_URL now; applying
  # ingress in the dashboard updates the public origin to the domain.
  LOGIN_URL="http://${PUBLIC_IP:-$LOCAL_IP}:${PUBLISH_PORT}"
  PUBLIC_URL="${SWARMY_PUBLIC_URL:-$LOGIN_URL}"
  ok "tier=${DB_TIER} ingress=${INGRESS} mesh=${MESH} login=${LOGIN_URL}${DOMAIN:+ domain=$DOMAIN (after ingress)}"
}

# ════════════════════════════════════════════════════════════════════════════
# Phase 5/6/7 — secrets, swarm, docker secrets
# ════════════════════════════════════════════════════════════════════════════
gen_secret() { openssl rand -base64 32; }

ensure_secrets() {  # persist-once into state.env (NEVER regenerate)
  state_load
  [ -n "${SWARMY_SECRET_KEY:-}" ]   || state_set SWARMY_SECRET_KEY "$(gen_secret)"
  [ -n "${BETTER_AUTH_SECRET:-}" ]  || state_set BETTER_AUTH_SECRET "$(gen_secret)"
  [ -n "${POSTGRES_PASSWORD:-}" ]   || state_set POSTGRES_PASSWORD "$(gen_secret | tr -d '/+=')"
  state_set ADMIN_PASSWORD "$ADMIN_PASSWORD"
  if [ -z "${BOOTSTRAP_JOIN_TOKEN:-}" ]; then
    state_set BOOTSTRAP_JOIN_TOKEN "swt_$(openssl rand -hex 2)_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
  fi
  # Mesh (opt-in): persisted even when blank so re-runs without --mesh don't
  # silently drop a previously-configured token (mirrors ADMIN_PASSWORD above).
  state_set NB_MANAGEMENT_URL "${NB_MANAGEMENT_URL:-}"
  state_set NB_SERVICE_TOKEN "${NB_SERVICE_TOKEN:-}"
  ok "secrets persisted to $STATE_FILE (back this up — SWARMY_SECRET_KEY is unrecoverable)."
}

ensure_swarm() {
  if [ "$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null)" = active ]; then
    ok "Docker Swarm already active."
  else
    say "Initialising Docker Swarm (advertise ${LOCAL_IP})…"
    docker swarm init --advertise-addr "${LOCAL_IP:?need a local IP}" >/dev/null \
      || die "docker swarm init failed."
    ok "Swarm initialised."
  fi
  state_set SWARM_ID "$(docker info -f '{{.Swarm.Cluster.ID}}' 2>/dev/null)"
  state_set SWARM_MANAGER_ADDR "${LOCAL_IP}:2377"
  state_set SWARM_WORKER_TOKEN "$(docker swarm join-token -q worker)"
  state_set SWARM_MANAGER_TOKEN "$(docker swarm join-token -q manager)"
  state_set NODE_HOSTNAME "$(docker node inspect self --format '{{.Description.Hostname}}')"
}

secret_put() {  # secret_put NAME VALUE — create iff missing (external secrets are immutable)
  local name="$1" val="$2"
  if docker secret inspect "$name" >/dev/null 2>&1; then return 0; fi
  printf '%s' "$val" | docker secret create "$name" - >/dev/null || die "failed to create docker secret $name"
}
ensure_docker_secrets() {
  state_load
  say "Creating Docker secrets…"
  secret_put swarmy_secret_key     "$SWARMY_SECRET_KEY"
  secret_put better_auth_secret    "$BETTER_AUTH_SECRET"
  secret_put admin_password        "$ADMIN_PASSWORD"
  secret_put bootstrap_join_token  "$BOOTSTRAP_JOIN_TOKEN"
  secret_put swarm_worker_token    "$SWARM_WORKER_TOKEN"
  secret_put swarm_manager_token   "$SWARM_MANAGER_TOKEN"
  # Always created (possibly empty) so the stack file can reference it
  # unconditionally — an empty token makes ensureMeshConfig() skip, same
  # opt-in-by-absence behavior as every other mesh env var.
  secret_put mesh_service_token    "${NB_SERVICE_TOKEN:-}"
  [ "$DB_TIER" = standard ] && secret_put postgres_password "$POSTGRES_PASSWORD"
  ok "secrets present."
}

# ════════════════════════════════════════════════════════════════════════════
# Phase 8 — deploy control plane
# ════════════════════════════════════════════════════════════════════════════
write_stack_file() {  # emit the chosen stack file to $STATE_DIR (self-contained curl|sh path)
  local dst="$STATE_DIR/swarmy.${DB_TIER}.stack.yml" src
  for src in "deploy/swarmy.${DB_TIER}.stack.yml" "$(dirname "$0")/../deploy/swarmy.${DB_TIER}.stack.yml"; do
    if [ -f "$src" ]; then cp "$src" "$dst"; printf '%s' "$dst"; return; fi
  done
  die "stack file deploy/swarmy.${DB_TIER}.stack.yml not found (run from a checkout, or fetch it alongside this script)."
}
deploy_stack() {
  state_load
  local f; f="$(write_stack_file)"
  local mesh_driver=""
  [ "$MESH" = none ] || mesh_driver="netbird"
  say "Deploying the swarmy control plane (${DB_TIER})…"
  SWARMY_IMAGE="$IMAGE" \
  SWARMY_PUBLIC_URL="$PUBLIC_URL" \
  SWARMY_ADMIN_EMAIL="$ADMIN_EMAIL" \
  SWARMY_SWARM_ID="$SWARM_ID" \
  SWARMY_MANAGER_ADDR="$SWARM_MANAGER_ADDR" \
  SWARMY_PUBLISH_PORT="$PUBLISH_PORT" \
  SWARMY_NODE_HOSTNAME="$NODE_HOSTNAME" \
  SWARMY_MESH_DRIVER="$mesh_driver" \
  SWARMY_MESH_MANAGEMENT_URL="${NB_MANAGEMENT_URL:-}" \
    docker stack deploy --with-registry-auth -c "$f" "$STACK_NAME" >/dev/null \
    || die "docker stack deploy failed."
  say "Waiting for the controller to become healthy…"
  local i
  for i in $(seq 1 120); do
    curl -fsS -m 2 "http://localhost:${PUBLISH_PORT}/health" >/dev/null 2>&1 && { ok "controller healthy at http://localhost:${PUBLISH_PORT}."; return; }
    sleep 2
  done
  die "controller did not become healthy in time — check 'docker service logs ${STACK_NAME}_controller'."
}

# ════════════════════════════════════════════════════════════════════════════
# Phase 10 — enrol THIS host as node #1 (agent on the overlay)
# ════════════════════════════════════════════════════════════════════════════
enrol_node1() {
  state_load
  if docker ps --format '{{.Names}}' | grep -qx "$AGENT_CONTAINER"; then
    ok "node #1 agent already running."
    return
  fi
  say "Enrolling this host as node #1…"
  docker pull "$AGENT_IMAGE" >/dev/null 2>&1 || warn "could not pull $AGENT_IMAGE; using local copy if present."
  docker run -d --name "$AGENT_CONTAINER" --restart unless-stopped \
    --network "$OVERLAY_NET" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v swarmy-agent:/var/lib/swarmy \
    -e AGENT_WS_URL="ws://${CONTROLLER_DNS}/agent/ws" \
    -e SWARMY_JOIN_TOKEN="$BOOTSTRAP_JOIN_TOKEN" \
    -e SWARMY_AGENT_STATE=/var/lib/swarmy/agent.json \
    -e SWARMY_ALLOW_MESH=true \
    "$AGENT_IMAGE" >/dev/null \
    || die "failed to start node #1 agent."
  ok "node #1 agent started (watch it turn ONLINE in the dashboard)."
}

# ════════════════════════════════════════════════════════════════════════════
# Phase 11/12 — ingress + mesh (collected config → dashboard for live apply)
# ════════════════════════════════════════════════════════════════════════════
# Live ingress/mesh provisioning runs through the controller once node #1 is
# ONLINE (the ingress driver dispatches a RenderedConfig to an agent; the mesh
# driver mints a per-node setup key). v1 records the operator's choice + secrets
# and hands off to the dashboard's Networking page for the one-click apply, which
# already drives packages/ingress (cloudflared/caddy) and packages/mesh (netbird).
configure_ingress() {
  [ "$INGRESS" = none ] && return
  warn "Ingress '${INGRESS}' for ${DOMAIN}: open the dashboard → Networking → Ingress to apply."
  case "$INGRESS" in
    caddy)      say "  Caddy needs a DNS A record ${DOMAIN} → ${PUBLIC_IP:-<public-ip>} and inbound 80/443." ;;
    cloudflare) say "  Cloudflare Tunnel: paste the API token in the dashboard; it provisions the tunnel + CNAME (no inbound ports)." ;;
  esac
}
configure_mesh() {
  [ "$MESH" = none ] && return
  # deploy_stack() already ran bootstrap (ensureMeshConfig persists MeshConfig
  # directly via Prisma) before this runs, so mesh is live — every "Add a node"
  # token minted from here embeds a fresh single-use NetBird setup key.
  ok "Mesh '${MESH}' is configured — new join tokens (dashboard → Add a node) auto-join NetBird before the swarm."
}

# ════════════════════════════════════════════════════════════════════════════
# Phase 13 — finalize
# ════════════════════════════════════════════════════════════════════════════
finalize() {
  state_load
  hr
  ok "swarmy is up."
  printf '\n'
  printf '  Dashboard:  %s\n' "${LOGIN_URL:-$PUBLIC_URL}"
  printf '  Login:      %s\n' "$ADMIN_EMAIL"
  if [ "${GENERATED_PW:-0}" = 1 ]; then printf '  Password:   %s   %s\n' "$ADMIN_PASSWORD" "${c_yellow}(generated — save it now)${c_reset}"; fi
  [ -n "$DOMAIN" ] && printf '  Domain:     https://%s  %s\n' "$DOMAIN" "${c_dim}(active once ingress is applied in the dashboard)${c_reset}"
  printf '\n'
  printf '  Add a node:  curl -fsSL %s/install.sh | SWARMY_JOIN_TOKEN=%s sh\n' "${LOGIN_URL:-$PUBLIC_URL}" "$BOOTSTRAP_JOIN_TOKEN"
  printf '\n'
  warn "BACK UP $STATE_FILE (esp. SWARMY_SECRET_KEY). Lose it and every stored credential is unrecoverable."
  hr
}

# ── uninstall ───────────────────────────────────────────────────────────────
do_uninstall() {
  need_root
  warn "Removing the swarmy stack, node #1 agent, and secrets (the swarm itself is left intact)."
  docker rm -f "$AGENT_CONTAINER" >/dev/null 2>&1 || true
  docker stack rm "$STACK_NAME" >/dev/null 2>&1 || true
  sleep 3
  for s in swarmy_secret_key better_auth_secret admin_password bootstrap_join_token swarm_worker_token swarm_manager_token mesh_service_token postgres_password; do
    docker secret rm "$s" >/dev/null 2>&1 || true
  done
  ok "removed. Data volumes (swarmy-data / swarmy-pgdata) and $STATE_FILE are preserved; delete them manually to wipe state."
}

# ── main ────────────────────────────────────────────────────────────────────
main() {
  hr; say "swarmy self-host installer"
  case "$MODE" in
    uninstall) do_uninstall; exit 0 ;;
    check) discover; egress_gate; ok "preflight complete (no changes made)."; exit 0 ;;
  esac

  need_root
  discover
  marker_done egress   || { egress_gate;        marker_set egress; }
  marker_done docker   || { ensure_docker;      marker_set docker; }
  wizard
  ensure_secrets
  marker_done swarm    || { ensure_swarm;        marker_set swarm; }
  ensure_docker_secrets
  deploy_stack
  enrol_node1
  configure_ingress
  configure_mesh
  finalize
}
main "$@"
