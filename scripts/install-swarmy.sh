#!/usr/bin/env bash
#
# install-swarmy.sh — stand up a self-hosted swarmy control plane on a fresh VPS.
#
#   curl -fsSL https://raw.githubusercontent.com/requestflo/swarmy/main/scripts/install-swarmy.sh | sudo bash
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
#   --admin-email <e>            SWARMY_ADMIN_EMAIL (a value without "@" is a username login)
#   --admin-password <p>         SWARMY_ADMIN_PASSWORD   (generated if unset)
#   --domain <host>              SWARMY_DOMAIN — the dashboard's https domain (point an A
#                                record at this box). On a public-IP box it defaults to
#                                swarmy.<ip-with-dashes>.sslip.io: swarmy's Caddy edge
#                                gets a Let's Encrypt cert for it automatically.
#   --no-https                   SWARMY_NO_HTTPS=1 — keep the dashboard on plain
#                                http://<ip>:<port> only (--https re-enables it).
#   --ingress none|caddy|cloudflare        SWARMY_INGRESS
#   --mesh none|netbird-cloud|netbird-external   SWARMY_MESH
#   --image <ref>                SWARMY_IMAGE       (controller image)
#   --agent-image <ref>          SWARMY_AGENT_IMAGE
#   --port <n>                   SWARMY_PUBLISH_PORT (default 3021)
#   --allow-signup               SWARMY_ALLOW_SIGNUP=true — open self-registration.
#                                Default (unset): invite-only — only the seeded owner
#                                and people an admin invites can create accounts.
# Cloudflare (when --ingress cloudflare): CF_API_TOKEN, CF_ACCOUNT_ID, CF_ZONE_ID
# NetBird (when --mesh netbird-*):        NB_SERVICE_TOKEN, NB_MANAGEMENT_URL
set -euo pipefail

# ── constants ───────────────────────────────────────────────────────────────
DEFAULT_IMAGE="ghcr.io/requestflo/swarmy-controller:latest"
DEFAULT_AGENT_IMAGE="ghcr.io/requestflo/swarmy-agent:latest"
# Where a curl|bash install fetches its companion files (stack files) from.
SWARMY_RAW_BASE="${SWARMY_RAW_BASE:-https://raw.githubusercontent.com/requestflo/swarmy/${SWARMY_REF:-main}}"
STACK_NAME="swarmy"
STATE_DIR="/var/lib/swarmy/install"
STATE_FILE="$STATE_DIR/state.env"
OVERLAY_NET="swarmy"                           # SHARED platform overlay: edge ↔ routed apps, collector, Garage
CONTROL_NET="swarmy-control"                   # PRIVATE control plane: controller + its DB (external in the stack file)
CONTROLLER_DNS="swarmy_controller:3021"        # service name on swarmy-control
# Platform services that bridge both overlays (they must reach the controller /
# ClickHouse on swarmy-control): moved onto it BEFORE the controller leaves `swarmy`.
CONTROL_BRIDGES="swarmy-ingress-caddy swarmy-cloudflared swarmy-otel-collector swarmy-clickhouse"
AGENT_CONTAINER="swarmy-agent"
NETBIRD_CONTAINER="swarmy-netbird"
NETBIRD_IMAGE="${SWARMY_NETBIRD_IMAGE:-netbirdio/netbird:latest}"
NB_INTERFACE="wt0"

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
NO_HTTPS="${SWARMY_NO_HTTPS:-0}"
DASHBOARD_DOMAIN=""
INGRESS="${SWARMY_INGRESS:-none}"
MESH="${SWARMY_MESH:-none}"
IMAGE="${SWARMY_IMAGE:-$DEFAULT_IMAGE}"
AGENT_IMAGE="${SWARMY_AGENT_IMAGE:-$DEFAULT_AGENT_IMAGE}"
PUBLISH_PORT="${SWARMY_PUBLISH_PORT:-3021}"
ALLOW_SIGNUP="${SWARMY_ALLOW_SIGNUP:-}"

# Which settings the operator gave THIS run (flag or env). Anything not given
# falls back to what the first install recorded in state.env — a re-run with
# no flags must never silently switch tier, image, port or sign-up policy.
EXPLICIT=" "
for v in DB_TIER ADMIN_EMAIL IMAGE AGENT_IMAGE PUBLISH_PORT ALLOW_SIGNUP DOMAIN NO_HTTPS; do
  case "$v" in
    DB_TIER) [ -n "${SWARMY_DB_TIER:-}" ] && EXPLICIT="$EXPLICIT$v " ;;
    ADMIN_EMAIL) [ -n "${SWARMY_ADMIN_EMAIL:-}" ] && EXPLICIT="$EXPLICIT$v " ;;
    IMAGE) [ -n "${SWARMY_IMAGE:-}" ] && EXPLICIT="$EXPLICIT$v " ;;
    AGENT_IMAGE) [ -n "${SWARMY_AGENT_IMAGE:-}" ] && EXPLICIT="$EXPLICIT$v " ;;
    PUBLISH_PORT) [ -n "${SWARMY_PUBLISH_PORT:-}" ] && EXPLICIT="$EXPLICIT$v " ;;
    ALLOW_SIGNUP) [ -n "${SWARMY_ALLOW_SIGNUP:-}" ] && EXPLICIT="$EXPLICIT$v " ;;
    DOMAIN) [ -n "${SWARMY_DOMAIN:-}" ] && EXPLICIT="$EXPLICIT$v " ;;
    NO_HTTPS) [ -n "${SWARMY_NO_HTTPS:-}" ] && EXPLICIT="$EXPLICIT$v " ;;
  esac
done
explicit() { case "$EXPLICIT" in *" $1 "*) return 0 ;; esac; return 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --non-interactive) NON_INTERACTIVE=1 ;;
    --check) MODE="check" ;;
    --uninstall) MODE="uninstall" ;;
    --standard) DB_TIER="standard" EXPLICIT="${EXPLICIT}DB_TIER " ;;
    --admin-email) ADMIN_EMAIL="${2:?}"; EXPLICIT="${EXPLICIT}ADMIN_EMAIL "; shift ;;
    --admin-password) ADMIN_PASSWORD="${2:?}"; shift ;;
    --domain) DOMAIN="${2:?}"; EXPLICIT="${EXPLICIT}DOMAIN "; shift ;;
    --no-https) NO_HTTPS=1 EXPLICIT="${EXPLICIT}NO_HTTPS " ;;
    --https) NO_HTTPS=0 EXPLICIT="${EXPLICIT}NO_HTTPS " ;;
    --ingress) INGRESS="${2:?}"; shift ;;
    --mesh) MESH="${2:?}"; shift ;;
    --image) IMAGE="${2:?}"; EXPLICIT="${EXPLICIT}IMAGE "; shift ;;
    --agent-image) AGENT_IMAGE="${2:?}"; EXPLICIT="${EXPLICIT}AGENT_IMAGE "; shift ;;
    --port) PUBLISH_PORT="${2:?}"; EXPLICIT="${EXPLICIT}PUBLISH_PORT "; shift ;;
    --allow-signup) ALLOW_SIGNUP="true" EXPLICIT="${EXPLICIT}ALLOW_SIGNUP " ;;
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

# Restore settings the first install recorded (CFG_*) unless given this run,
# then record the effective values for the next re-run.
remember_settings() {
  state_load
  local v saved
  for v in DB_TIER ADMIN_EMAIL IMAGE AGENT_IMAGE PUBLISH_PORT ALLOW_SIGNUP DOMAIN NO_HTTPS; do
    eval "saved=\${CFG_$v:-}"
    [ -n "$saved" ] || continue
    if explicit "$v"; then
      if [ "$v" = DB_TIER ] && [ "$DB_TIER" != "$saved" ]; then
        die "this controller was installed with the '$saved' datastore tier; switching to '$DB_TIER' would start it on an EMPTY database. Re-run without changing the tier (migrate with a controller backup + restore instead)."
      fi
    else
      eval "$v=\$saved"
    fi
  done
  for v in DB_TIER ADMIN_EMAIL IMAGE AGENT_IMAGE PUBLISH_PORT ALLOW_SIGNUP DOMAIN NO_HTTPS; do
    eval "state_set CFG_$v \"\${$v}\""
  done
}
marker_set()  { state_set "MARK_$1" 1; }

# ── https dashboard domain (pure — unit-tested by sourcing this file) ─────────
# sslip_domain IP → swarmy.<a-b-c-d>.sslip.io for a valid IPv4, else fails.
# sslip.io resolves <a-b-c-d>.sslip.io to a.b.c.d, so Let's Encrypt HTTP-01
# validates against this box with no DNS setup at all.
sslip_domain() {
  local ip="$1" o
  printf '%s' "$ip" | grep -qE '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' || return 1
  for o in ${ip//./ }; do [ "$o" -le 255 ] || return 1; done
  printf 'swarmy.%s.sslip.io' "${ip//./-}"
}
# dashboard_domain VERDICT PUBLIC_IP DOMAIN NO_HTTPS INGRESS → the domain swarmy's
# Caddy edge should serve the dashboard on, or nothing (plain http only).
#   --no-https wins; an explicit --domain is used as given; otherwise only a
#   box that holds its public IP (verdict `bound`) gets the sslip.io default —
#   behind NAT nothing inbound reaches :80/:443, so ACME could never succeed.
#   A Cloudflare Tunnel fronts the dashboard itself (no Caddy vhost).
dashboard_domain() {
  local verdict="$1" ip="$2" domain="$3" no_https="${4:-0}" ingress="${5:-none}"
  [ "$no_https" = 1 ] && return 0
  [ "$ingress" = cloudflare ] && return 0
  if [ -n "$domain" ]; then printf '%s' "$domain" | tr '[:upper:]' '[:lower:]'; return 0; fi
  [ "$verdict" = bound ] || return 0
  sslip_domain "$ip" || true
}

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
    # Any HTTP response proves egress — registry roots answer 401/404, so no -f.
    curl -sS -m 6 -o /dev/null "https://$h" 2>/dev/null \
      || die "no egress to https://$h — swarmy needs to pull images. Fix outbound networking and re-run."
  done
  ok "egress reachable: $hosts."
}

# ════════════════════════════════════════════════════════════════════════════
# Phase 3 — Docker
# ════════════════════════════════════════════════════════════════════════════
# Small VPSs (1 GB, no swap — the default on most providers) OOM-kill the
# controller during first boot (embedded Postgres + migrations peak well above
# its ~450 MB steady state). A modest swap file is the standard fix; only
# added when RAM < 2 GB and no swap is configured, and never on re-runs.
ensure_swap() {
  local mem_kb swap_kb
  mem_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  swap_kb="$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  [ "${mem_kb:-0}" -gt 0 ] && [ "${mem_kb}" -lt 2000000 ] && [ "${swap_kb:-0}" -eq 0 ] || return 0
  [ -e /swapfile ] && return 0
  say "Low-memory host ($(( mem_kb / 1024 )) MB, no swap) — adding a 2 GB swap file…"
  if { fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none; } \
    && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile; then
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    sysctl -qw vm.swappiness=10 2>/dev/null || true
    ok "swap enabled."
  else
    rm -f /swapfile
    warn "could not add swap — on a 1 GB host the controller may be OOM-killed during first boot."
  fi
}

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

# >>> swarmy docker-log-opts (keep in sync: apps/api/src/install/docker-log-opts.ts)
SWARMY_LOG_MAX_SIZE="${SWARMY_LOG_MAX_SIZE:-10m}"
SWARMY_LOG_MAX_FILE="${SWARMY_LOG_MAX_FILE:-3}"
SWARMY_JOURNALD_MAX="${SWARMY_JOURNALD_MAX:-500M}"

# merge_log_opts FILE → prints the merged daemon.json on stdout.
# exit 0 = changed (stdout is the new file) · 3 = already configured, leave it
# · 2 = cannot merge safely (no python3/jq, or unparseable JSON).
merge_log_opts() {
  mlo_file="$1"
  mlo_default="{\"log-driver\": \"json-file\", \"log-opts\": {\"max-size\": \"$SWARMY_LOG_MAX_SIZE\", \"max-file\": \"$SWARMY_LOG_MAX_FILE\"}}"
  if [ ! -s "$mlo_file" ] || ! grep -q '[^[:space:]]' "$mlo_file"; then
    printf '%s\n' "$mlo_default"
    return 0
  fi
  if grep -q '"log-driver"' "$mlo_file" || grep -q '"log-opts"' "$mlo_file"; then
    return 3
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$mlo_file" "$SWARMY_LOG_MAX_SIZE" "$SWARMY_LOG_MAX_FILE" <<'SWARMY_PY_EOF' || return 2
import json, sys
with open(sys.argv[1]) as f:
    cfg = json.load(f)
if not isinstance(cfg, dict):
    sys.exit(2)
cfg["log-driver"] = "json-file"
cfg["log-opts"] = {"max-size": sys.argv[2], "max-file": sys.argv[3]}
print(json.dumps(cfg, indent=2))
SWARMY_PY_EOF
    return 0
  fi
  if command -v jq >/dev/null 2>&1; then
    jq --arg s "$SWARMY_LOG_MAX_SIZE" --arg n "$SWARMY_LOG_MAX_FILE" \
      'if type == "object" then . + {"log-driver": "json-file", "log-opts": {"max-size": $s, "max-file": $n}} else error("not an object") end' \
      "$mlo_file" 2>/dev/null || return 2
    return 0
  fi
  return 2
}

# ensure_docker_log_opts — apply merge_log_opts to /etc/docker/daemon.json safely.
ensure_docker_log_opts() {
  edlo_file="${SWARMY_DAEMON_JSON:-/etc/docker/daemon.json}"
  edlo_tmp="$(mktemp)"
  edlo_rc=0
  merge_log_opts "$edlo_file" > "$edlo_tmp" || edlo_rc=$?
  if [ "$edlo_rc" -eq 3 ]; then
    rm -f "$edlo_tmp"
    ok "Docker log rotation already configured in $edlo_file — leaving it."
  elif [ "$edlo_rc" -ne 0 ]; then
    rm -f "$edlo_tmp"
    warn "Could not merge log rotation into $edlo_file (needs python3 or jq). swarmy services are still bounded (json-file 10m x 3)."
  else
    if command -v dockerd >/dev/null 2>&1 && dockerd --validate --config-file "$edlo_tmp" >/dev/null 2>&1; then
      :
    elif command -v dockerd >/dev/null 2>&1 && dockerd --help 2>&1 | grep -q -- '--validate'; then
      rm -f "$edlo_tmp"
      warn "Merged daemon.json failed dockerd --validate — left $edlo_file untouched."
      edlo_tmp=""
    fi
    if [ -n "$edlo_tmp" ]; then
      mkdir -p "$(dirname "$edlo_file")"
      [ -f "$edlo_file" ] && cp -p "$edlo_file" "$edlo_file.swarmy-bak"
      cat "$edlo_tmp" > "$edlo_file"
      rm -f "$edlo_tmp"
      if [ -z "$(docker ps -q 2>/dev/null)" ] && command -v systemctl >/dev/null 2>&1; then
        if systemctl restart docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
          ok "Docker log rotation on (json-file $SWARMY_LOG_MAX_SIZE x $SWARMY_LOG_MAX_FILE)."
        else
          warn "Docker did not come back with the new daemon.json — restoring the previous one."
          if [ -f "$edlo_file.swarmy-bak" ]; then cp -p "$edlo_file.swarmy-bak" "$edlo_file"; else rm -f "$edlo_file"; fi
          systemctl restart docker >/dev/null 2>&1 || true
        fi
      else
        ok "Docker log rotation written to $edlo_file — applies to new containers after the next Docker restart."
      fi
    fi
  fi
  # journald cap (the systemd-backend agent logs there): only when not already set.
  if [ -d /etc/systemd ] && command -v systemctl >/dev/null 2>&1 && [ ! -e /etc/systemd/journald.conf.d/swarmy.conf ] \
    && ! grep -qs '^SystemMaxUse=' /etc/systemd/journald.conf; then
    mkdir -p /etc/systemd/journald.conf.d
    printf '[Journal]\nSystemMaxUse=%s\n' "$SWARMY_JOURNALD_MAX" > /etc/systemd/journald.conf.d/swarmy.conf
    systemctl restart systemd-journald >/dev/null 2>&1 || true
  fi
  return 0
}
# <<< swarmy docker-log-opts

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
  # Email is optional: a value without "@" is a username login.
  [ -n "$ADMIN_EMAIL" ] || ADMIN_EMAIL="$(prompt 'Admin username or email' 'admin')"
  if [ -z "$ADMIN_PASSWORD" ]; then
    ADMIN_PASSWORD="$(prompt_secret 'Admin password (blank = generate)')"
    [ -n "$ADMIN_PASSWORD" ] || { ADMIN_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"; GENERATED_PW=1; }
  fi

  if [ "$NON_INTERACTIVE" != 1 ] && [ "$DB_TIER" = lite ]; then
    case "$(choose 'Datastore tier' lite lite standard)" in standard) DB_TIER=standard ;; esac
  fi

  # HTTPS dashboard: a public-IP box gets one automatically (sslip.io default),
  # served by swarmy's own Caddy edge — no ingress question needed.
  local auto_domain; auto_domain="$(dashboard_domain "$NAT_VERDICT" "$PUBLIC_IP" "$DOMAIN" "$NO_HTTPS" "$INGRESS")"
  if [ -n "$auto_domain" ] && [ "$INGRESS" = none ]; then INGRESS=caddy; fi

  # Ingress — recommend based on detected reachability.
  if [ "$INGRESS" = none ] && [ "$NON_INTERACTIVE" != 1 ]; then
    local rec=none
    case "$NAT_VERDICT" in bound) rec=caddy ;; nat|cgnat|unknown) rec=cloudflare ;; esac
    say "Network looks '${NAT_VERDICT}'. Suggested public ingress: ${rec} (or 'none' = reach via http://${PUBLIC_IP:-<ip>}:${PUBLISH_PORT})."
    INGRESS="$(choose 'Public ingress for the dashboard' "$rec" none caddy cloudflare)"
  fi
  if [ "$INGRESS" != none ] && [ -z "$DOMAIN" ] && [ -z "$auto_domain" ]; then DOMAIN="$(prompt 'Domain (e.g. swarmy.example.com)')"; fi
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
  # Behind NAT the public IP only works with a port-forward the operator hasn't
  # set up yet; the LAN address is what a browser on the same network can reach.
  local login_host="${LOCAL_IP:-$PUBLIC_IP}"
  [ "$NAT_VERDICT" = bound ] && login_host="${PUBLIC_IP:-$LOCAL_IP}"
  LOGIN_URL="http://${login_host}:${PUBLISH_PORT}"
  # With an https dashboard domain, EVERYTHING swarmy hands out (auth base URL,
  # invite links, install/repair one-liners) uses it; LOGIN_URL stays the
  # direct http origin (trusted by auth) for the minute before the cert exists.
  DASHBOARD_DOMAIN="$(dashboard_domain "$NAT_VERDICT" "$PUBLIC_IP" "$DOMAIN" "$NO_HTTPS" "$INGRESS")"
  state_set DASHBOARD_DOMAIN "$DASHBOARD_DOMAIN"
  if [ -n "$DASHBOARD_DOMAIN" ]; then
    PUBLIC_URL="${SWARMY_PUBLIC_URL:-https://$DASHBOARD_DOMAIN}"
  else
    PUBLIC_URL="${SWARMY_PUBLIC_URL:-$LOGIN_URL}"
  fi
  ok "tier=${DB_TIER} ingress=${INGRESS} mesh=${MESH} login=${LOGIN_URL}${DASHBOARD_DOMAIN:+ https=https://$DASHBOARD_DOMAIN}${DOMAIN:+ domain=$DOMAIN}"
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

mesh_ip() { { ip -4 -o addr show dev "${NB_INTERFACE}" 2>/dev/null || true; } | awk '{print $4}' | cut -d/ -f1 | head -n1; }

# With a mesh, node #1 joins it BEFORE the swarm exists, so the swarm is born
# advertising the mesh IP. A manager's address is fixed at `swarm init`: one
# left on its public IP while nodes join on mesh IPs breaks encrypted overlays
# (IPsec SAs are keyed on the advertised addresses) — the swarmy overlay, and
# with it every ingress route.
# nb_setup_key TYPE USES TTL NAME — mint a NetBird setup key with the PAT; prints the key.
nb_setup_key() {
  local api="${NB_MANAGEMENT_URL%/}" resp key
  resp="$(curl -fsS -X POST "${api}/api/setup-keys" \
    -H "Authorization: Token ${NB_SERVICE_TOKEN}" -H 'Content-Type: application/json' \
    -d "{\"name\":\"$4\",\"type\":\"$1\",\"expires_in\":$3,\"auto_groups\":[],\"usage_limit\":$2,\"ephemeral\":false}" 2>&1)" \
    || die "could not mint a NetBird setup key at ${api} (check the token): ${resp}"
  key="$(printf '%s' "$resp" | sed -n 's/.*"key":"\([^"]*\)".*/\1/p')"
  [ -n "$key" ] || die "NetBird returned no setup key: ${resp}"
  printf '%s' "$key"
}

ensure_mesh_node1() {
  [ "$MESH" = none ] && return 0
  MESH_IP="$(mesh_ip)"
  if [ -n "$MESH_IP" ]; then ok "mesh already up on ${NB_INTERFACE} (${MESH_IP})."; return 0; fi
  [ -n "${NB_SERVICE_TOKEN:-}" ] || die "--mesh ${MESH} needs NB_SERVICE_TOKEN (a NetBird Personal Access Token)."
  local api="${NB_MANAGEMENT_URL%/}" key i
  say "Joining the NetBird mesh before forming the swarm…"
  key="$(nb_setup_key one-off 1 3600 "swarmy node #1 $(hostname)")"
  docker pull "$NETBIRD_IMAGE" >/dev/null 2>&1 || warn "could not pull $NETBIRD_IMAGE; using local copy if present."
  docker rm -f "$NETBIRD_CONTAINER" >/dev/null 2>&1 || true
  # Same name/volume the agent's applyMesh uses, so it adopts this client.
  docker run -d --name "$NETBIRD_CONTAINER" --restart unless-stopped --network host \
    --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
    --cap-add NET_ADMIN --cap-add SYS_ADMIN --cap-add SYS_RESOURCE --device /dev/net/tun \
    -v "${NETBIRD_CONTAINER}:/var/lib/netbird" \
    -e NB_SETUP_KEY="$key" -e NB_MANAGEMENT_URL="$api" -e NB_INTERFACE_NAME="$NB_INTERFACE" \
    "$NETBIRD_IMAGE" >/dev/null || die "failed to start the NetBird client."
  for i in $(seq 1 60); do
    MESH_IP="$(mesh_ip)"; [ -n "$MESH_IP" ] && break; sleep 1
  done
  [ -n "$MESH_IP" ] || die "NetBird did not come up within 60s (docker logs ${NETBIRD_CONTAINER}). Re-run, or install with --mesh none."
  ok "mesh up (${MESH_IP})."
}

ensure_swarm() {
  local adv="${MESH_IP:-${LOCAL_IP:?need a local IP}}"
  if [ "$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null)" = active ]; then
    ok "Docker Swarm already active."
    adv="$(docker info --format '{{.Swarm.NodeAddr}}' 2>/dev/null)"; adv="${adv:-$LOCAL_IP}"
  else
    say "Initialising Docker Swarm (advertise ${adv})…"
    if [ -n "${MESH_IP:-}" ]; then
      docker swarm init --advertise-addr "$adv" --data-path-addr "$adv" >/dev/null || die "docker swarm init failed."
    else
      docker swarm init --advertise-addr "$adv" >/dev/null || die "docker swarm init failed."
    fi
    ok "Swarm initialised."
  fi
  state_set SWARM_ID "$(docker info -f '{{.Swarm.Cluster.ID}}' 2>/dev/null)"
  state_set SWARM_MANAGER_ADDR "${adv}:2377"
  state_set SWARM_WORKER_TOKEN "$(docker swarm join-token -q worker)"
  state_set SWARM_MANAGER_TOKEN "$(docker swarm join-token -q manager)"
  state_set NODE_HOSTNAME "$(docker node inspect self --format '{{.Description.Hostname}}')"
}

secret_put() {  # secret_put NAME VALUE — create iff missing (external secrets are immutable)
  local name="$1" val="$2"
  if docker secret inspect "$name" >/dev/null 2>&1; then return 0; fi
  # Docker refuses empty secret data; a lone newline reads back as "" once the
  # entrypoint's $(cat …) strips it, so "unset" survives the round trip.
  [ -n "$val" ] || val=$'\n'
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
  # curl | bash: no checkout on disk — fetch the stack file for the same ref.
  local url="${SWARMY_RAW_BASE}/deploy/swarmy.${DB_TIER}.stack.yml"
  curl -fsSL "$url" -o "$dst" 2>/dev/null \
    || die "could not fetch the stack file from $url (set SWARMY_RAW_BASE or run from a checkout)."
  printf '%s' "$dst"
}
# Overlay MTU when the swarm data path rides the WireGuard mesh: VXLAN (50) +
# IPsec ESP (≤60) must fit inside the tunnel MTU (NetBird wt0 = 1280 → 1170),
# or large packets fragment/black-hole across nodes (TLS stalls, pings fine).
# Mirrors overlayMtuFor() in packages/core/src/network-policy.ts.
overlay_mtu() {
  local link=""
  [ -r "/sys/class/net/${NB_INTERFACE}/mtu" ] && link="$(cat "/sys/class/net/${NB_INTERFACE}/mtu" 2>/dev/null || true)"
  if [ -z "$link" ] && [ "$MESH" != none ]; then link=1280; fi
  [ -n "$link" ] && printf '%s' "$((link - 50 - 60))"
}

# create_overlay NAME — encrypted, attachable, MTU-sized for the mesh. Idempotent;
# an EXISTING network's MTU can't change in place, so only warn about it.
create_overlay() {
  local name="$1" mtu have
  mtu="$(overlay_mtu || true)"
  if docker network inspect "$name" >/dev/null 2>&1; then
    have="$(docker network inspect "$name" -f '{{index .Options "com.docker.network.driver.mtu"}}' 2>/dev/null || true)"
    if [ -n "$mtu" ] && { [ -z "$have" ] || [ "$have" -gt "$mtu" ]; }; then
      warn "overlay $name has MTU ${have:-1500 (default)} but the mesh needs ≤ $mtu — large cross-node packets may stall. Recreating it is disruptive; see docs (verify with scripts/verify-networking.sh)."
    fi
    return 0
  fi
  # shellcheck disable=SC2086
  docker network create --driver overlay --attachable --opt encrypted \
    ${mtu:+--opt com.docker.network.driver.mtu=$mtu} \
    --label swarmy.managed=true --label "swarmy.role=$2" "$name" >/dev/null \
    || die "could not create the $name overlay network."
}

ensure_overlay() {  # the stack file references swarmy-control as external — create both first
  create_overlay "$OVERLAY_NET" platform
  create_overlay "$CONTROL_NET" control
}

# Existing installs: every platform service that must reach the control plane
# joins swarmy-control BEFORE the controller/Postgres leave `swarmy` (the stack
# deploy below), so the dashboard vhost / telemetry never lose their upstream.
# `--network-add` is a rolling update; Caddy blips once. Idempotent.
migrate_control_bridges() {
  local svc nets
  # The node-#1 agent dials swarmy_controller:3021 — give it the control net first.
  if docker ps --format '{{.Names}}' | grep -qx "$AGENT_CONTAINER" \
    && ! docker inspect "$AGENT_CONTAINER" --format '{{json .NetworkSettings.Networks}}' | grep -q "\"$CONTROL_NET\""; then
    docker network connect "$CONTROL_NET" "$AGENT_CONTAINER" >/dev/null 2>&1 \
      && ok "node #1 agent connected to the $CONTROL_NET overlay."
  fi
  for svc in $CONTROL_BRIDGES; do
    docker service inspect "$svc" >/dev/null 2>&1 || continue
    nets="$(docker service inspect "$svc" -f '{{range .Spec.TaskTemplate.Networks}}{{.Target}} {{end}}' 2>/dev/null || true)"
    case " $nets " in *" $(docker network inspect "$CONTROL_NET" -f '{{.Id}}') "*) continue ;; esac
    say "Moving $svc onto the private $CONTROL_NET network…"
    timeout 180 docker service update --quiet --network-add "$CONTROL_NET" "$svc" >/dev/null 2>&1 \
      || warn "could not add $svc to $CONTROL_NET yet — the controller's reconcile will retry."
  done
}

deploy_stack() {
  ensure_overlay
  migrate_control_bridges
  state_load
  local f; f="$(write_stack_file)"
  local mesh_driver="" trusted_proxies=""
  [ "$MESH" = none ] || mesh_driver="netbird"
  # Caddy reaches the controller over swarmy-control: trust that subnet's
  # X-Forwarded-For so auth rate limits see real clients, not Caddy's address.
  # (Never the shared `swarmy` subnet — any routed app could spoof XFF from it.)
  if [ -n "$DASHBOARD_DOMAIN" ]; then
    trusted_proxies="$(docker network inspect "$CONTROL_NET" -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null | xargs || true)"
    [ -z "$trusted_proxies" ] || trusted_proxies="127.0.0.0/8 ::1/128 $trusted_proxies"
  fi
  say "Deploying the swarmy control plane (${DB_TIER})…"
  SWARMY_IMAGE="$IMAGE" \
  SWARMY_PUBLIC_URL="$PUBLIC_URL" \
  SWARMY_DASHBOARD_DOMAIN="$DASHBOARD_DOMAIN" \
  SWARMY_DIRECT_URL="$LOGIN_URL" \
  SWARMY_TRUSTED_PROXIES="$trusted_proxies" \
  SWARMY_ADMIN_EMAIL="$(case "$ADMIN_EMAIL" in *@*) printf '%s' "$ADMIN_EMAIL" ;; esac)" \
  SWARMY_ADMIN_USERNAME="$(case "$ADMIN_EMAIL" in *@*) ;; *) printf '%s' "$ADMIN_EMAIL" ;; esac)" \
  SWARMY_SWARM_ID="$SWARM_ID" \
  SWARMY_MANAGER_ADDR="$SWARM_MANAGER_ADDR" \
  SWARMY_PUBLISH_PORT="$PUBLISH_PORT" \
  SWARMY_ALLOW_SIGNUP="$ALLOW_SIGNUP" \
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
  # Re-run = upgrade: if a newer agent image is available, replace the running
  # container. Its identity lives on the swarmy-agent volume, so it reconnects
  # on its stored session (no join token needed).
  if docker ps --format '{{.Names}}' | grep -qx "$AGENT_CONTAINER"; then
    docker pull "$AGENT_IMAGE" >/dev/null 2>&1 || true
    local running want
    running="$(docker inspect "$AGENT_CONTAINER" --format '{{.Image}}' 2>/dev/null || true)"
    want="$(docker image inspect "$AGENT_IMAGE" --format '{{.Id}}' 2>/dev/null || true)"
    if [ -n "$want" ] && [ "$running" != "$want" ]; then
      say "Upgrading node #1 agent…"
      docker rm -f "$AGENT_CONTAINER" >/dev/null
    fi
  fi
  if docker ps --format '{{.Names}}' | grep -qx "$AGENT_CONTAINER"; then
    # The agent dials swarmy_controller:3021, which now lives ONLY on the
    # private control network — connect it there (live, no restart). It stays
    # on `swarmy` too (in-cluster names like swarmy-garage). Older installs
    # attached it to the stack-prefixed `swarmy_swarmy`; drop that.
    local net
    for net in "$CONTROL_NET" "$OVERLAY_NET"; do
      if ! docker inspect "$AGENT_CONTAINER" --format '{{json .NetworkSettings.Networks}}' | grep -q "\"$net\""; then
        docker network connect "$net" "$AGENT_CONTAINER" >/dev/null 2>&1 || true
        ok "node #1 agent connected to the $net overlay."
      fi
    done
    docker network disconnect "${STACK_NAME}_swarmy" "$AGENT_CONTAINER" >/dev/null 2>&1 || true
    ok "node #1 agent already running."
    return
  fi
  say "Enrolling this host as node #1…"
  docker pull "$AGENT_IMAGE" >/dev/null 2>&1 || warn "could not pull $AGENT_IMAGE; using local copy if present."
  docker run -d --name "$AGENT_CONTAINER" --restart unless-stopped \
    --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
    --network "$CONTROL_NET" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v swarmy-agent:/var/lib/swarmy \
    -e AGENT_WS_URL="ws://${CONTROLLER_DNS}/agent/ws" \
    -e SWARMY_JOIN_TOKEN="$BOOTSTRAP_JOIN_TOKEN" \
    -e SWARMY_AGENT_STATE=/var/lib/swarmy/agent.json \
    -e SWARMY_ALLOW_MESH=true \
    "$AGENT_IMAGE" >/dev/null \
    || die "failed to start node #1 agent."
  docker network connect "$OVERLAY_NET" "$AGENT_CONTAINER" >/dev/null 2>&1 || true
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
  if [ -n "$DASHBOARD_DOMAIN" ]; then
    # Served automatically: the bootstrap seed binds the domain to the org's
    # Caddy edge (dashboard vhost → swarmy_controller:3021) and ACME does the rest.
    say "HTTPS dashboard at https://${DASHBOARD_DOMAIN} via swarmy's Caddy edge (needs inbound 80/443${DOMAIN:+ and a DNS A record ${DASHBOARD_DOMAIN} → ${PUBLIC_IP:-<public-ip>}})."
    return
  fi
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
# Bounded wait for the edge to deploy + ACME to issue (non-fatal): prints the
# https URL as ready only when a real TLS handshake + /health succeeds.
HTTPS_READY=0
wait_https() {
  [ -n "$DASHBOARD_DOMAIN" ] || return 0
  local i max="${SWARMY_HTTPS_WAIT:-180}"
  say "Waiting for the https certificate for ${DASHBOARD_DOMAIN} (up to ${max}s)…"
  for i in $(seq 1 $(( max / 5 ))); do
    if curl -fsS -m 4 "https://${DASHBOARD_DOMAIN}/health" >/dev/null 2>&1; then HTTPS_READY=1; ok "https://${DASHBOARD_DOMAIN} is live."; return 0; fi
    sleep 5
  done
  warn "https://${DASHBOARD_DOMAIN} is not answering yet — the certificate usually issues within a minute or two of the edge coming up."
}

finalize() {
  state_load
  local share="${PUBLIC_URL:-$LOGIN_URL}"
  hr
  ok "swarmy is up."
  printf '\n'
  if [ -n "$DASHBOARD_DOMAIN" ]; then
    printf '  Dashboard:  https://%s\n' "$DASHBOARD_DOMAIN"
    if [ "$HTTPS_READY" != 1 ]; then
      printf '              %s\n' "${c_dim}(certificate issues in ~1 min; until then ${LOGIN_URL} works)${c_reset}"
    fi
  else
    printf '  Dashboard:  %s\n' "${LOGIN_URL:-$PUBLIC_URL}"
  fi
  printf '  Login:      %s\n' "$ADMIN_EMAIL"
  if [ "${GENERATED_PW:-0}" = 1 ]; then printf '  Password:   %s   %s\n' "$ADMIN_PASSWORD" "${c_yellow}(generated — save it now)${c_reset}"; fi
  if [ -n "$DOMAIN" ] && [ -z "$DASHBOARD_DOMAIN" ]; then
    printf '  Domain:     https://%s  %s\n' "$DOMAIN" "${c_dim}(active once ingress is applied in the dashboard)${c_reset}"
  fi
  printf '\n'
  # With a mesh, the bootstrap line carries a NetBird key with the same reach
  # (5 nodes / 24h), so the first nodes join on mesh IPs like the manager.
  local mesh_env=""
  if [ "$MESH" != none ] && [ -n "${NB_SERVICE_TOKEN:-}" ]; then
    local k; k="$(nb_setup_key reusable 5 86400 'swarmy bootstrap one-liner')" || k=""
    [ -z "$k" ] || mesh_env="SWARMY_MESH_SETUP_KEY=$k SWARMY_MESH_MANAGEMENT_URL=${NB_MANAGEMENT_URL%/} SWARMY_MESH_DRIVER=netbird "
  fi
  printf '  Add a node:  curl -fsSL %s/install/loader.sh | %sSWARMY_JOIN_TOKEN=%s sh -s -- --controller %s\n' \
    "$share" "$mesh_env" "$BOOTSTRAP_JOIN_TOKEN" "$share"
  if [ -n "$DASHBOARD_DOMAIN" ] && [ "$HTTPS_READY" != 1 ]; then
    printf '               %s\n' "${c_dim}(until the certificate is issued, swap https://${DASHBOARD_DOMAIN} for ${LOGIN_URL} in this command)${c_reset}"
  fi
  printf '               %s\n' "${c_dim}(this token works for 24h / 5 nodes — after that use Add a node in the dashboard)${c_reset}"
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
  ensure_swap
  marker_done docker   || { ensure_docker;      marker_set docker; }
  ensure_docker_log_opts   # idempotent: leaves an operator's log config alone
  remember_settings
  wizard
  ensure_secrets
  ensure_mesh_node1
  marker_done swarm    || { ensure_swarm;        marker_set swarm; }
  ensure_docker_secrets
  deploy_stack
  enrol_node1
  configure_ingress
  configure_mesh
  wait_https
  finalize
}
# Sourced (tests: `bash -c '. scripts/install-swarmy.sh; dashboard_domain …'`)
# → only define functions. Executed or piped (`curl … | bash`) → run.
if ! (return 0 2>/dev/null); then main "$@"; fi
