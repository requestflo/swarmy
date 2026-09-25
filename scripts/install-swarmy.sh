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
#   --admin-email <e>            SWARMY_ADMIN_EMAIL (a value without "@" is a username login)
#   --admin-password <p>         SWARMY_ADMIN_PASSWORD   (generated if unset)
#   --domain <host>              SWARMY_DOMAIN — the dashboard's https domain (point an A
#                                record at this box). On a public-IP box it defaults to
#                                swarmy.<ip-with-dashes>.sslip.io: swarmy's Caddy edge
#                                gets a Let's Encrypt cert for it automatically.
#   --no-https                   SWARMY_NO_HTTPS=1 — keep the dashboard on plain
#                                http://<ip>:<port> only (--https re-enables it).
#   --ingress none|caddy|cloudflare        SWARMY_INGRESS
#   --mesh swarmy|none|netbird-cloud|netbird-external   SWARMY_MESH (default: swarmy —
#                                NetBird runs inside swarmy, started here on this host's
#                                network before the swarm exists; 'none' opts out)
#   --mesh-domain <host>         SWARMY_MESH_DOMAIN — the mesh control plane's name
#                                (default mesh.<dashboard domain>, else mesh-<ip>.sslip.io)
#   --mesh-tls letsencrypt|edge|none   SWARMY_MESH_TLS (default: edge behind swarmy's
#                                Caddy, letsencrypt on a public box without it, else none)
#   --cluster-name <slug>        SWARMY_CLUSTER_NAME — namespaces this cluster's mesh objects
#   SWARMY_MESH_EXTRA_CA=<pem>   a private CA the mesh control plane must trust for
#                                swarmy's https address (it only accepts https issuers)
#   --default-addr-pool <cidr>   swarm overlay pool (default with a mesh: 10.2xx.0.0/16,
#                                clear of the 10.0.x LANs people's laptops sit on)
#   --image <ref>                SWARMY_IMAGE       (controller image)
#   --agent-image <ref>          SWARMY_AGENT_IMAGE
#   --port <n>                   SWARMY_PUBLISH_PORT (default 3021)
#   --allow-signup               SWARMY_ALLOW_SIGNUP=true — open self-registration.
#                                Default (unset): invite-only — only the seeded owner
#                                and people an admin invites can create accounts.
#   --release-pubkey <file|pem>  SWARMY_RELEASE_PUBKEY — the key platform-upgrade manifests
#                                must be signed with (forks / self-builders). A PEM file
#                                path or the PEM itself; empty = the built-in release key.
#   --platform-feed-url <url>    SWARMY_PLATFORM_FEED_URL — the platform release feed base
#                                (serves <channel>/platform.json[.sig]; an air-gapped
#                                mirror). Empty = the GitHub releases feed.
# Cloudflare (when --ingress cloudflare): CF_API_TOKEN, CF_ACCOUNT_ID, CF_ZONE_ID
# NetBird (when --mesh netbird-*):        NB_SERVICE_TOKEN, NB_MANAGEMENT_URL
# (--mesh swarmy needs neither: this script starts NetBird and mints the token.)
set -euo pipefail
# Everything this script writes under $STATE_DIR holds secrets (vault key, auth
# secret, admin password, swarm manager token, NetBird PAT): owner-only by
# default. Steps that write system files other users/daemons read
# (/etc/docker/daemon.json, journald drop-ins, the Docker install) switch to
# 022 explicitly — see with_public_umask.
umask 077

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
INTEGRATIONS_NET="swarmy-integrations"         # controller → in-swarm integration targets only (AI engines, alert/webhook targets)
CONTROLLER_DNS="swarmy_controller:3021"        # service name on swarmy-control
# Platform services that bridge both overlays (they must reach the controller /
# ClickHouse on swarmy-control): moved onto it BEFORE the controller leaves `swarmy`.
CONTROL_BRIDGES="swarmy-ingress-caddy swarmy-cloudflared swarmy-otel-collector swarmy-clickhouse"
AGENT_CONTAINER="swarmy-agent"
AGENT_ENV_FILE="${SWARMY_AGENT_ENV_FILE:-/etc/swarmy/agent.env}"   # 0600, mounted :ro into the agent
NETBIRD_CONTAINER="swarmy-netbird"
NETBIRD_IMAGE="${SWARMY_NETBIRD_IMAGE:-ghcr.io/netbirdio/netbird:0.79.0@sha256:9d8480d87b7f7c10d67b820eecf332ecca5c2756792d4bdfa532182b4fc3005f}"
NB_INTERFACE="wt0"
# Self-hosted mesh control plane (--mesh swarmy). Same name/volume/tmpfs/entrypoint
# as the agent's supervisor (apps/agent/src/handlers/mesh-control.ts), so it adopts it.
MESH_CONTROL_CONTAINER="swarmy-mesh-control"
MESH_CONTROL_IMAGE="${SWARMY_NETBIRD_SERVER_IMAGE:-ghcr.io/netbirdio/netbird-server:0.79.0@sha256:d1da0c0179c9e6f2ab7b48be54d06341b11037855a9426b9f2536aa79f13360b}"
MESH_CONTROL_HTTP_PORT=8081

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
# The one control-plane stack (embedded SQLite store; no database service).
STACK_FILE="swarmy.lite.stack.yml"
ADMIN_EMAIL="${SWARMY_ADMIN_EMAIL:-}"
ADMIN_PASSWORD="${SWARMY_ADMIN_PASSWORD:-}"
DOMAIN="${SWARMY_DOMAIN:-}"
NO_HTTPS="${SWARMY_NO_HTTPS:-0}"
DASHBOARD_DOMAIN=""
INGRESS="${SWARMY_INGRESS:-none}"
MESH="${SWARMY_MESH:-swarmy}"
MESH_EXPLICIT=0; [ -n "${SWARMY_MESH:-}" ] && MESH_EXPLICIT=1
MESH_DOMAIN="${SWARMY_MESH_DOMAIN:-}"
MESH_TLS="${SWARMY_MESH_TLS:-}"
CLUSTER_NAME="${SWARMY_CLUSTER_NAME:-}"
# PEM file of a private CA that swarmy's https address uses (NetBird must trust it).
MESH_EXTRA_CA="${SWARMY_MESH_EXTRA_CA:-}"
# Behind a fronting proxy on another port than 443 (--mesh-tls edge only).
MESH_PUBLIC_PORT="${SWARMY_MESH_PUBLIC_PORT:-}"
ADDR_POOL="${SWARMY_DEFAULT_ADDR_POOL:-}"
IMAGE="${SWARMY_IMAGE:-$DEFAULT_IMAGE}"
AGENT_IMAGE="${SWARMY_AGENT_IMAGE:-$DEFAULT_AGENT_IMAGE}"
PUBLISH_PORT="${SWARMY_PUBLISH_PORT:-3021}"
ALLOW_SIGNUP="${SWARMY_ALLOW_SIGNUP:-}"
RELEASE_PUBKEY="${SWARMY_RELEASE_PUBKEY:-}"
PLATFORM_FEED_URL="${SWARMY_PLATFORM_FEED_URL:-}"

# Which settings the operator gave THIS run (flag or env). Anything not given
# falls back to what the first install recorded in state.env — a re-run with
# no flags must never silently switch image, port or sign-up policy.
EXPLICIT=" "
for v in ADMIN_EMAIL IMAGE AGENT_IMAGE PUBLISH_PORT ALLOW_SIGNUP DOMAIN NO_HTTPS RELEASE_PUBKEY PLATFORM_FEED_URL; do
  case "$v" in
    RELEASE_PUBKEY) [ -n "${SWARMY_RELEASE_PUBKEY:-}" ] && EXPLICIT="$EXPLICIT$v " ;;
    PLATFORM_FEED_URL) [ -n "${SWARMY_PLATFORM_FEED_URL:-}" ] && EXPLICIT="$EXPLICIT$v " ;;
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
    --standard) die "--standard was removed: the controller always runs its embedded SQLite store (no Postgres service)." ;;
    --admin-email) ADMIN_EMAIL="${2:?}"; EXPLICIT="${EXPLICIT}ADMIN_EMAIL "; shift ;;
    --admin-password) ADMIN_PASSWORD="${2:?}"; shift ;;
    --domain) DOMAIN="${2:?}"; EXPLICIT="${EXPLICIT}DOMAIN "; shift ;;
    --no-https) NO_HTTPS=1 EXPLICIT="${EXPLICIT}NO_HTTPS " ;;
    --https) NO_HTTPS=0 EXPLICIT="${EXPLICIT}NO_HTTPS " ;;
    --ingress) INGRESS="${2:?}"; shift ;;
    --mesh) MESH="${2:?}"; MESH_EXPLICIT=1; shift ;;
    --mesh-domain) MESH_DOMAIN="${2:?}"; shift ;;
    --mesh-tls) MESH_TLS="${2:?}"; shift ;;
    --cluster-name) CLUSTER_NAME="${2:?}"; shift ;;
    --default-addr-pool) ADDR_POOL="${2:?}"; shift ;;
    --image) IMAGE="${2:?}"; EXPLICIT="${EXPLICIT}IMAGE "; shift ;;
    --agent-image) AGENT_IMAGE="${2:?}"; EXPLICIT="${EXPLICIT}AGENT_IMAGE "; shift ;;
    --port) PUBLISH_PORT="${2:?}"; EXPLICIT="${EXPLICIT}PUBLISH_PORT "; shift ;;
    --allow-signup) ALLOW_SIGNUP="true" EXPLICIT="${EXPLICIT}ALLOW_SIGNUP " ;;
    --release-pubkey) RELEASE_PUBKEY="${2:?}"; EXPLICIT="${EXPLICIT}RELEASE_PUBKEY "; shift ;;
    --platform-feed-url) PLATFORM_FEED_URL="${2:?}"; EXPLICIT="${EXPLICIT}PLATFORM_FEED_URL "; shift ;;
    -h|--help) grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done

case "$MESH" in self-hosted|managed) MESH=swarmy ;; esac

# ── platform-upgrade trust (pure — unit-tested by sourcing this file) ────────
# release_pubkey_value FILE|PEM → the PEM text (a readable file is read, so the
# key survives the file going away), or fails when it isn't a PEM public key.
release_pubkey_value() {
  local v="$1" pem="$1"
  [ -n "$v" ] || return 0
  if [ -f "$v" ]; then pem="$(cat "$v")" || return 1; fi
  case "$pem" in *"-----BEGIN PUBLIC KEY-----"*"-----END PUBLIC KEY-----"*) printf '%s' "$pem" ;; *) return 1 ;; esac
}
# platform_feed_url_ok URL → succeeds for an empty value or an http(s) URL base.
platform_feed_url_ok() {
  [ -z "$1" ] && return 0
  printf '%s' "$1" | grep -qE '^https?://[^[:space:]/]+[^[:space:]]*$'
}
if [ -n "$RELEASE_PUBKEY" ]; then
  RELEASE_PUBKEY="$(release_pubkey_value "$RELEASE_PUBKEY")" \
    || die "--release-pubkey / SWARMY_RELEASE_PUBKEY must be a PEM public key or a readable file holding one (-----BEGIN PUBLIC KEY-----)."
fi
platform_feed_url_ok "$PLATFORM_FEED_URL" \
  || die "--platform-feed-url / SWARMY_PLATFORM_FEED_URL must be an http(s):// URL (the base serving <channel>/platform.json)."

# ── served addresses (pure — unit-tested by sourcing this file) ─────────────
# host_addresses [PUBLIC_IP] → space-separated addresses this host answers on
# (every non-loopback IPv4 of its interfaces, plus the public IP). The
# controller trusts sign-in from each of them (SWARMY_DIRECT_HOSTS): on a
# multi-homed host the LAN, mesh and public addresses all reach the dashboard,
# not only LOGIN_URL. `SWARMY_HOST_ADDRESSES` overrides detection (tests).
host_addresses() {
  local pub="${1:-}" list
  list="${SWARMY_HOST_ADDRESSES-$( { hostname -I 2>/dev/null || ip -o -4 addr show 2>/dev/null | awk '{sub(/\/.*/, "", $4); print $4}'; } | tr ' ' '\n')}"
  printf '%s\n%s\n' "$list" "$pub" | tr ' ' '\n' \
    | awk '/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ && !/^(127\.|169\.254\.|0\.)/ && !seen[$0]++ { printf "%s%s", sep, $0; sep = " " } END { if (sep) print "" }'
}

# ── state helpers ───────────────────────────────────────────────────────────
# shellcheck source=/dev/null
state_load() { [ -f "$STATE_FILE" ] && . "$STATE_FILE" || true; }
state_dir() {  # the root-only state dir (0700 even when it pre-exists from an older install)
  mkdir -p "$STATE_DIR"; chmod 700 "$STATE_DIR"
}
state_set() {  # state_set KEY VALUE  — persist (and export) a value, replacing any prior.
  local key="$1" val="$2" tmp
  state_dir; touch "$STATE_FILE"; chmod 600 "$STATE_FILE"
  # mktemp creates the temp file 0600 with an unpredictable name — never a
  # world-readable "${STATE_FILE}.tmp" window holding every secret.
  tmp="$(mktemp "$STATE_DIR/.state.XXXXXX")"
  grep -v "^${key}=" "$STATE_FILE" > "$tmp" 2>/dev/null || true
  printf '%s=%q\n' "$key" "$val" >> "$tmp"
  chmod 600 "$tmp"; mv "$tmp" "$STATE_FILE"
  export "$key=$val"
}
# with_public_umask CMD… — run CMD with umask 022 (files other daemons/users
# must read: daemon.json, journald.conf.d, apt keyrings from get.docker.com).
with_public_umask() {
  local old rc=0; old="$(umask)"; umask 022
  "$@" || rc=$?
  umask "$old"; return "$rc"
}
marker_done() { state_load; local v; eval "v=\${MARK_$1:-}"; [ "$v" = "1" ]; }

# Restore settings the first install recorded (CFG_*) unless given this run,
# then record the effective values for the next re-run.
remember_settings() {
  state_load
  local v saved
  eval "saved=\${CFG_DB_TIER:-}"
  if [ -n "$saved" ] && [ "$saved" != lite ]; then
    die "this controller was installed with the '$saved' datastore tier (Postgres), which no longer exists. Take a fresh install; there is no migration path from a Postgres-era controller."
  fi
  for v in ADMIN_EMAIL IMAGE AGENT_IMAGE PUBLISH_PORT ALLOW_SIGNUP DOMAIN NO_HTTPS RELEASE_PUBKEY PLATFORM_FEED_URL; do
    eval "saved=\${CFG_$v:-}"
    [ -n "$saved" ] || continue
    explicit "$v" || eval "$v=\$saved"
  done
  for v in ADMIN_EMAIL IMAGE AGENT_IMAGE PUBLISH_PORT ALLOW_SIGNUP DOMAIN NO_HTTPS RELEASE_PUBKEY PLATFORM_FEED_URL; do
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

# ── self-hosted mesh (pure — unit-tested by sourcing this file) ──────────────
# mesh_domain EXPLICIT DASHBOARD_DOMAIN IP → the mesh control plane's name.
#   --mesh-domain wins; else mesh.<dashboard domain> (a name you control, so a
#   later move keeps it); else mesh-<a-b-c-d>.sslip.io (convenience only: it
#   pins this IP, so moving the control plane means everyone signs in again).
mesh_domain() {
  local explicit="$1" dash="$2" ip="$3"
  if [ -n "$explicit" ]; then printf '%s' "$explicit" | tr '[:upper:]' '[:lower:]'; return 0; fi
  if [ -n "$dash" ]; then printf 'mesh.%s' "$dash"; return 0; fi
  printf '%s' "$ip" | grep -qE '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' || return 1
  printf 'mesh-%s.sslip.io' "${ip//./-}"
}
# mesh_tls_mode EXPLICIT INGRESS DASHBOARD_DOMAIN VERDICT → letsencrypt|edge|none
#   behind swarmy's Caddy edge the edge owns :443 (TLS handover from the start);
#   a public box without it uses NetBird's own ACME; a LAN/NAT box plain HTTP.
mesh_tls_mode() {
  local explicit="$1" ingress="$2" dash="$3" verdict="$4"
  if [ -n "$explicit" ]; then printf '%s' "$explicit"; return 0; fi
  if [ "$ingress" = caddy ] && [ -n "$dash" ]; then printf 'edge'; return 0; fi
  if [ "$verdict" = bound ]; then printf 'letsencrypt'; return 0; fi
  printf 'none'
}
# mesh_public_url DOMAIN TLS → what peers, browsers and the controller dial.
mesh_public_url() {
  if [ "$2" = none ]; then printf 'http://%s:%s' "$1" "$MESH_CONTROL_HTTP_PORT"
  elif [ "$2" = edge ] && [ -n "${MESH_PUBLIC_PORT:-}" ] && [ "$MESH_PUBLIC_PORT" != 443 ]; then printf 'https://%s:%s' "$1" "$MESH_PUBLIC_PORT"
  else printf 'https://%s' "$1"; fi
}
# mesh_tls_env TLS EDGE_LISTEN [PUBLIC_PORT] → SWARMY_MESH_TLS for the controller
# (parseMeshTlsEnv in packages/core/src/mesh-bootstrap.ts). Behind the edge,
# NetBird boots in `none` and the controller hands over (`;bootstrap=`).
mesh_tls_env() {
  case "$1" in
    none) printf 'none:%s' "$MESH_CONTROL_HTTP_PORT" ;;
    edge) printf 'edge=%s%s;bootstrap=none:%s' "$2" "${3:+@$3}" "$MESH_CONTROL_HTTP_PORT" ;;
    *) printf 'letsencrypt' ;;
  esac
}
# mesh_addr_pool SEED → 10.<200..249>.0.0/16, stable per seed: uncommon (clear of
# the 10.0.x home/office LANs laptops sit on) and distinct per cluster.
mesh_addr_pool() {
  local n; n="$(printf '%s' "$1" | cksum | awk '{print $1}')"
  printf '10.%s.0.0/16' "$(( 200 + n % 50 ))"
}
# mesh_control_config DOMAIN TLS LISTEN AUTH_SECRET ENC_KEY → the NetBird combined
# server config (JSON is YAML). Mirrors renderMeshControlConfig in
# packages/mesh/src/control-plane/server-config.ts (the controller re-renders it;
# a difference only costs one restart). No disableDefaultPolicy: the combined
# server ignores it — the Default policy is deleted after setup instead.
mesh_control_config() {
  local domain="$1" tls="$2" listen="$3" auth="$4" key="$5" exposed issuer tlsblock=""
  if [ "$tls" = none ]; then exposed="http://${domain}:${MESH_CONTROL_HTTP_PORT}"
  elif [ "$tls" = edge ]; then exposed="https://${domain}:${MESH_PUBLIC_PORT:-443}"
  else exposed="https://${domain}:443"; fi
  issuer="$(mesh_public_url "$domain" "$tls")/oauth2"
  if [ "$tls" = letsencrypt ]; then
    tlsblock=",
    \"tls\": { \"letsencrypt\": { \"enabled\": true, \"dataDir\": \"/var/lib/netbird/letsencrypt\", \"domains\": [\"${domain}\"] } }"
  fi
  cat <<SWARMY_NB_EOF
# swarmy-managed NetBird control plane — rendered by install-swarmy.sh.
{
  "server": {
    "auth": {
      "cliRedirectURIs": ["http://localhost:53000/", "http://localhost:54000/"],
      "issuer": "${issuer}",
      "localAuthDisabled": false,
      "signKeyRefreshEnabled": true
    },
    "authSecret": "${auth}",
    "dataDir": "/var/lib/netbird/",
    "disableAnonymousMetrics": true,
    "disableGeoliteUpdate": true,
    "exposedAddress": "${exposed}",
    "healthcheckAddress": "127.0.0.1:9000",
    "listenAddress": "${listen}",
    "logFile": "console",
    "logLevel": "info",
    "metricsPort": 9090,
    "store": { "encryptionKey": "${key}", "engine": "sqlite" },
    "stunPorts": [3478]${tlsblock}
  }
}
SWARMY_NB_EOF
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

# >>> swarmy docker-registry-mirror (keep in sync: apps/api/src/install/docker-registry-mirror.ts)
SWARMY_REGISTRY_MIRROR="${SWARMY_REGISTRY_MIRROR-http://localhost:5001}"
SWARMY_REGISTRY_MIRROR_FALLBACK="${SWARMY_REGISTRY_MIRROR_FALLBACK-https://mirror.gcr.io}"
case "$SWARMY_REGISTRY_MIRROR_FALLBACK" in off|none) SWARMY_REGISTRY_MIRROR_FALLBACK="" ;; esac

# merge_registry_mirror FILE → prints the merged daemon.json on stdout.
# exit 0 = changed (stdout is the new file) · 3 = already configured, leave it
# · 2 = cannot merge safely (no python3/jq, or unparseable JSON).
# Mirrors = [the cache, the fallback]: dockerd moves to the next mirror when the
# cache errors (a 500 while Hub rate-limits it), then to Hub itself. A list that
# is exactly swarmy's older [cache] is upgraded; any other list is the operator's.
merge_registry_mirror() {
  mrm_file="$1"
  if [ ! -s "$mrm_file" ] || ! grep -q '[^[:space:]]' "$mrm_file"; then
    if [ -n "$SWARMY_REGISTRY_MIRROR_FALLBACK" ]; then
      printf '{"registry-mirrors": ["%s", "%s"]}\n' "$SWARMY_REGISTRY_MIRROR" "$SWARMY_REGISTRY_MIRROR_FALLBACK"
    else
      printf '{"registry-mirrors": ["%s"]}\n' "$SWARMY_REGISTRY_MIRROR"
    fi
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    mrm_rc=0
    python3 - "$mrm_file" "$SWARMY_REGISTRY_MIRROR" "$SWARMY_REGISTRY_MIRROR_FALLBACK" <<'SWARMY_PY_EOF' || mrm_rc=$?
import json, sys
with open(sys.argv[1]) as f:
    cfg = json.load(f)
if not isinstance(cfg, dict):
    sys.exit(2)
want = [m for m in sys.argv[2:4] if m]
have = cfg.get("registry-mirrors")
if have is not None and (have != [sys.argv[2]] or have == want):
    sys.exit(3)
cfg["registry-mirrors"] = want
print(json.dumps(cfg, indent=2))
SWARMY_PY_EOF
    case "$mrm_rc" in 0) return 0 ;; 3) return 3 ;; *) return 2 ;; esac
  fi
  if command -v jq >/dev/null 2>&1; then
    jq -e 'type == "object"' "$mrm_file" >/dev/null 2>&1 || return 2
    if jq -e 'has("registry-mirrors")' "$mrm_file" >/dev/null 2>&1; then
      jq -e --arg m "$SWARMY_REGISTRY_MIRROR" --arg f "$SWARMY_REGISTRY_MIRROR_FALLBACK" \
        '.["registry-mirrors"] == [$m] and $f != ""' "$mrm_file" >/dev/null 2>&1 || return 3
    fi
    jq --arg m "$SWARMY_REGISTRY_MIRROR" --arg f "$SWARMY_REGISTRY_MIRROR_FALLBACK" \
      '. + {"registry-mirrors": ([$m, $f] | map(select(. != "")))}' \
      "$mrm_file" 2>/dev/null || return 2
    return 0
  fi
  if grep -q '"registry-mirrors"' "$mrm_file"; then
    return 3
  fi
  return 2
}

# ensure_docker_registry_mirror — apply merge_registry_mirror to /etc/docker/daemon.json safely.
ensure_docker_registry_mirror() {
  case "$SWARMY_REGISTRY_MIRROR" in ''|off|none) return 0 ;; esac
  edrm_file="${SWARMY_DAEMON_JSON:-/etc/docker/daemon.json}"
  edrm_tmp="$(mktemp)"
  edrm_rc=0
  merge_registry_mirror "$edrm_file" > "$edrm_tmp" || edrm_rc=$?
  if [ "$edrm_rc" -eq 3 ]; then
    rm -f "$edrm_tmp"
    ok "Docker registry mirror already set in $edrm_file — leaving it."
    return 0
  elif [ "$edrm_rc" -ne 0 ]; then
    rm -f "$edrm_tmp"
    warn "Could not merge the registry mirror into $edrm_file (needs python3 or jq). Docker Hub pulls go direct."
    return 0
  fi
  if command -v dockerd >/dev/null 2>&1 && dockerd --validate --config-file "$edrm_tmp" >/dev/null 2>&1; then
    :
  elif command -v dockerd >/dev/null 2>&1 && dockerd --help 2>&1 | grep -q -- '--validate'; then
    rm -f "$edrm_tmp"
    warn "Merged daemon.json failed dockerd --validate — left $edrm_file untouched."
    return 0
  fi
  mkdir -p "$(dirname "$edrm_file")"
  [ -f "$edrm_file" ] && cp -p "$edrm_file" "$edrm_file.swarmy-bak"
  cat "$edrm_tmp" > "$edrm_file"
  rm -f "$edrm_tmp"
  if [ -z "$(docker ps -q 2>/dev/null)" ] && command -v systemctl >/dev/null 2>&1; then
    if systemctl restart docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
      ok "Docker Hub pulls go through the swarm's pull-through cache ($SWARMY_REGISTRY_MIRROR${SWARMY_REGISTRY_MIRROR_FALLBACK:+, then $SWARMY_REGISTRY_MIRROR_FALLBACK})."
    else
      warn "Docker did not come back with the new daemon.json — restoring the previous one."
      if [ -f "$edrm_file.swarmy-bak" ]; then cp -p "$edrm_file.swarmy-bak" "$edrm_file"; else rm -f "$edrm_file"; fi
      systemctl restart docker >/dev/null 2>&1 || true
    fi
  else
    ok "Registry mirror written to $edrm_file — applies after the next Docker restart."
  fi
  return 0
}
# <<< swarmy docker-registry-mirror

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

  # Mesh — NetBird inside swarmy by default (the swarm is born on it); 'none' opts out.
  # A re-run keeps what the first install chose; an install that predates the
  # choice being recorded keeps what it had (never a mesh sprung on a live swarm).
  if [ "$MESH_EXPLICIT" != 1 ]; then
    if [ -n "${CFG_MESH:-}" ]; then MESH="$CFG_MESH"
    elif marker_done swarm; then
      if [ -n "${NB_MANAGEMENT_URL:-}" ]; then MESH=netbird-external; else MESH=none; fi
    elif [ "$NON_INTERACTIVE" != 1 ]; then
      MESH="$(choose 'Overlay mesh (connect nodes anywhere, and people to their apps)' swarmy swarmy none netbird-cloud netbird-external)"
    fi
  fi
  case "$MESH" in self-hosted|managed) MESH=swarmy ;; esac
  case "$MESH" in swarmy|none|netbird-cloud|netbird-external) : ;; *) die "--mesh must be swarmy, none, netbird-cloud or netbird-external (got $MESH)." ;; esac
  state_set CFG_MESH "$MESH"
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
  if [ "$MESH" = swarmy ]; then
    # (CFG_MESH_* were loaded by remember_settings' state_load.)
    local mesh_ip_for="${PUBLIC_IP:-$LOCAL_IP}"; [ "$NAT_VERDICT" = bound ] || mesh_ip_for="${LOCAL_IP:-$PUBLIC_IP}"
    MESH_DOMAIN="$(mesh_domain "${MESH_DOMAIN:-${CFG_MESH_DOMAIN:-}}" "$DASHBOARD_DOMAIN" "$mesh_ip_for")" \
      || die "could not pick a mesh domain (no usable IP); pass --mesh-domain."
    MESH_TLS="$(mesh_tls_mode "${MESH_TLS:-${CFG_MESH_TLS:-}}" "$INGRESS" "$DASHBOARD_DOMAIN" "$NAT_VERDICT")"
    case "$MESH_TLS" in letsencrypt|edge|none) : ;; *) die "--mesh-tls must be letsencrypt, edge or none (got $MESH_TLS)." ;; esac
    CLUSTER_NAME="$(printf '%s' "${CLUSTER_NAME:-${CFG_CLUSTER_NAME:-swarmy}}" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | sed 's/-*$//' | cut -c1-32)"
    state_set CFG_MESH_DOMAIN "$MESH_DOMAIN"; state_set CFG_MESH_TLS "$MESH_TLS"; state_set CFG_CLUSTER_NAME "$CLUSTER_NAME"
    NB_MANAGEMENT_URL="$(mesh_public_url "$MESH_DOMAIN" "$MESH_TLS")"
  fi
  ok "ingress=${INGRESS} mesh=${MESH}${MESH_DOMAIN:+ (${MESH_DOMAIN}, tls ${MESH_TLS})} login=${LOGIN_URL}${DASHBOARD_DOMAIN:+ https=https://$DASHBOARD_DOMAIN}${DOMAIN:+ domain=$DOMAIN}"
}

# ════════════════════════════════════════════════════════════════════════════
# Phase 5/6/7 — secrets, swarm, docker secrets
# ════════════════════════════════════════════════════════════════════════════
gen_secret() { openssl rand -base64 32; }

ensure_secrets() {  # persist-once into state.env (NEVER regenerate)
  state_load
  [ -n "${SWARMY_SECRET_KEY:-}" ]   || state_set SWARMY_SECRET_KEY "$(gen_secret)"
  [ -n "${BETTER_AUTH_SECRET:-}" ]  || state_set BETTER_AUTH_SECRET "$(gen_secret)"
  state_set ADMIN_PASSWORD "$ADMIN_PASSWORD"
  if [ -z "${BOOTSTRAP_JOIN_TOKEN:-}" ]; then
    state_set BOOTSTRAP_JOIN_TOKEN "swt_$(openssl rand -hex 2)_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
  fi
  # Mesh (opt-in): persisted even when blank so re-runs without --mesh don't
  # silently drop a previously-configured token (mirrors ADMIN_PASSWORD above).
  state_set NB_MANAGEMENT_URL "${NB_MANAGEMENT_URL:-}"
  # --mesh swarmy mints its own service token (ensure_mesh_control); keep a prior one.
  state_set NB_SERVICE_TOKEN "${NB_SERVICE_TOKEN:-}"
  if [ "$MESH" = swarmy ]; then
    [ -n "${MESH_AUTH_SECRET:-}" ] || state_set MESH_AUTH_SECRET "$(openssl rand -hex 24)"
    [ -n "${MESH_ENCRYPTION_KEY:-}" ] || state_set MESH_ENCRYPTION_KEY "$(openssl rand -base64 32)"
    [ -n "${MESH_OWNER_PASSWORD:-}" ] || state_set MESH_OWNER_PASSWORD "$(openssl rand -base64 24 | tr -d '/+=')Aa1!"
  fi
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
  # With --mesh swarmy the key auto-joins swarmy:<c>:nodes (NB_NODES_GROUP_ID) and
  # the Admin API is reached on this host (NB_ADMIN_URL) — works before any edge.
  local api="${NB_ADMIN_URL:-${NB_MANAGEMENT_URL%/}}" resp key groups="[]"
  [ -n "${NB_NODES_GROUP_ID:-}" ] && groups="[\"${NB_NODES_GROUP_ID}\"]"
  # The PAT rides a curl config on stdin (-K -), never argv (visible in ps).
  resp="$(printf 'header = "Authorization: Token %s"\n' "$NB_SERVICE_TOKEN" | curl -fsS -K - -X POST "${api}/api/setup-keys" \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"$4\",\"type\":\"$1\",\"expires_in\":$3,\"auto_groups\":${groups},\"usage_limit\":$2,\"ephemeral\":false}" 2>&1)" \
    || die "could not mint a NetBird setup key at ${api} (check the token): ${resp}"
  key="$(printf '%s' "$resp" | sed -n 's/.*"key":"\([^"]*\)".*/\1/p')"
  [ -n "$key" ] || die "NetBird returned no setup key: ${resp}"
  printf '%s' "$key"
}

# ── --mesh swarmy: NetBird's control plane runs HERE, before the swarm exists ──
# nb_api METHOD PATH [BODY] [TOKEN] — this host's NetBird Admin API; prints the body.
nb_api() {
  local method="$1" path="$2" body="${3:-}" tok="${4:-${NB_SERVICE_TOKEN:-}}" scheme="${NB_AUTH_SCHEME:-Token}"
  if [ -n "$body" ]; then
    printf 'header = "Authorization: %s %s"\n' "$scheme" "$tok" | curl -fsS -m 20 -K - -X "$method" "${NB_ADMIN_URL}/api${path}" \
      -H 'Content-Type: application/json' -d "$body"
  else
    printf 'header = "Authorization: %s %s"\n' "$scheme" "$tok" | curl -fsS -m 20 -K - -X "$method" "${NB_ADMIN_URL}/api${path}"
  fi
}
json_field() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" | head -n1 || true; }
# The id of the object named NAME in a JSON list (NetBird lists are flat enough).
json_id_named() { { tr '{' '\n' | grep -F "\"name\":\"$1\"" || true; } | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -n1; }

# Up = the management gRPC server accepts connections. (Its :9000 /health is the
# relay's TLS check: 503 on a plain-HTTP listener, so it can't be the signal.)
# nb_owner_jwt EMAIL PASSWORD — sign in as the local owner through Dex's own
# auth-code + PKCE flow (the password form) and print an access token.
# Why not `POST /api/setup {create_pat:true}`: that path creates the NetBird
# account with an EMPTY domain, and single-account mode finds "the" account by
# its private domain — so every person signing in through the swarmy connector
# would get a new account of their own (found by the e2e). A JWT login creates
# the account the way the dashboard does (domain netbird.selfhosted, primary).
nb_owner_jwt() {
  local email="$1" pw="$2" base="$NB_ADMIN_URL" pub jar body hdr url loc action code i verifier challenge
  pub="$(mesh_public_url "$MESH_DOMAIN" "${MESH_BOOT_TLS:-$MESH_TLS}")"   # Dex's issuer as NetBird runs now
  jar="$(mktemp)"; body="$(mktemp)"; hdr="$(mktemp)"
  verifier="$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n')"
  challenge="$(printf '%s' "$verifier" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')"
  on_base() { case "$1" in "$pub"*) printf '%s%s' "$base" "${1#"$pub"}" ;; /*) printf '%s%s' "$base" "$1" ;; *) printf '%s' "$1" ;; esac; }
  url="${base}/oauth2/auth?client_id=netbird-cli&redirect_uri=http%3A%2F%2Flocalhost%3A53000%2F&response_type=code&scope=openid%20profile%20email&state=swarmy&code_challenge=${challenge}&code_challenge_method=S256"
  for i in 1 2 3 4 5 6 7 8; do
    curl -sS -m 20 -c "$jar" -b "$jar" -D "$hdr" -o "$body" "$url" || break
    loc="$(sed -n 's/^[Ll]ocation: *//p' "$hdr" | tr -d '\r' | head -n1)"
    [ -n "$loc" ] || break
    url="$(on_base "$loc")"
  done
  action="$(tr '\n' ' ' < "$body" | sed -n 's/.*<form[^>]*action="\([^"]*\)".*/\1/p' | sed 's/&amp;/\&/g')"
  [ -n "$action" ] || { rm -f "$jar" "$body" "$hdr"; return 1; }
  url="$(on_base "$action")"
  curl -sS -m 20 -c "$jar" -b "$jar" -D "$hdr" -o "$body" --data-urlencode "login=${email}" --data-urlencode "password=${pw}" "$url" || true
  for i in 1 2 3 4 5 6 7 8; do
    loc="$(sed -n 's/^[Ll]ocation: *//p' "$hdr" | tr -d '\r' | head -n1)"
    [ -n "$loc" ] || break
    case "$loc" in http://localhost:53000/*) code="$(printf '%s' "$loc" | sed -n 's/.*[?&]code=\([^&]*\).*/\1/p')"; break ;; esac
    url="$(on_base "$loc")"
    curl -sS -m 20 -c "$jar" -b "$jar" -D "$hdr" -o "$body" "$url" || break
  done
  rm -f "$jar" "$body" "$hdr"
  [ -n "${code:-}" ] || return 1
  curl -fsS -m 20 "${base}/oauth2/token" -d grant_type=authorization_code -d "code=${code}" \
    --data-urlencode "redirect_uri=http://localhost:53000/" -d client_id=netbird-cli -d "code_verifier=${verifier}" \
    | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p'
}

# mesh_handed_over — NetBird runs with its final (edge) config: exposedAddress is https.
mesh_handed_over() {
  docker exec "$MESH_CONTROL_CONTAINER" grep -q '"exposedAddress": "https://' /run/swarmy-mesh/config.yaml 2>/dev/null
}
# mesh_wait_handover — bounded wait for the controller's TLS handover (non-fatal).
mesh_wait_handover() {
  local i max="${SWARMY_MESH_HANDOVER_WAIT:-240}"
  mesh_handed_over && return 0
  say "Waiting for swarmy's edge to take over TLS for ${MESH_DOMAIN} (up to ${max}s)…"
  for i in $(seq 1 $(( max / 5 ))); do mesh_handed_over && return 0; sleep 5; done
  return 1
}

# >>> swarmy mesh-control firewall (keep in sync: apps/agent/src/handlers/mesh-firewall.ts)
# QA-014: netbird-server opens metrics (:9090) and the legacy gRPC port (:33073)
# on every interface, with no option to bind them. Drop those (and :9000) on
# INPUT except from loopback, Docker bridges and the mesh. The agent re-asserts it.
mesh_control_firewall() {
  local C=SWARMY-MESH-CTL ipt r found=0
  local rules="-i lo -j RETURN
-i docker0 -j RETURN
-i docker_gwbridge -j RETURN
-i br-+ -j RETURN
-i wt0 -j RETURN
-p tcp -m multiport --dports 9000,9090,33073 -j DROP"
  for ipt in iptables-legacy iptables-nft iptables; do
    command -v "$ipt" >/dev/null 2>&1 || continue
    "$ipt" -w -t filter -S INPUT >/dev/null 2>&1 || continue
    "$ipt" -w -t filter -S DOCKER-USER >/dev/null 2>&1 || continue
    found=1
    "$ipt" -w -N "$C" >/dev/null 2>&1 || true
    "$ipt" -w -F "$C"
    while IFS= read -r r; do
      [ -n "$r" ] || continue
      # shellcheck disable=SC2086
      "$ipt" -w -A "$C" $r
    done <<SWARMY_FW_EOF
$rules
SWARMY_FW_EOF
    "$ipt" -w -C INPUT -j "$C" >/dev/null 2>&1 || "$ipt" -w -I INPUT 1 -j "$C"
  done
  [ "$found" = 1 ] || warn "no iptables with Docker's chains — the mesh control plane's metrics port (9090) stays reachable; firewall it."
  return 0
}
# <<< swarmy mesh-control firewall

mesh_control_healthy() {
  docker exec "$MESH_CONTROL_CONTAINER" bash -c 'exec 3<>/dev/tcp/127.0.0.1/33073' 2>/dev/null
}

ensure_mesh_control() {
  state_load
  local listen docker0 cfg i client_url
  docker0="$(ip -4 -o addr show dev docker0 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n1)"
  case "$MESH_TLS" in
    letsencrypt) listen=":443"; NB_ADMIN_URL="https://${MESH_DOMAIN}" ;;
    edge) listen=":${MESH_CONTROL_HTTP_PORT}"; NB_ADMIN_URL="http://127.0.0.1:${MESH_CONTROL_HTTP_PORT}" ;;
    none) listen=":${MESH_CONTROL_HTTP_PORT}"; NB_ADMIN_URL="http://127.0.0.1:${MESH_CONTROL_HTTP_PORT}" ;;
  esac
  # Behind the edge, the edge doesn't exist yet: it deploys after `swarm init`,
  # which waits for the mesh (QA-012). So NetBird BOOTS in `none` (plain HTTP,
  # exposed on :8081) and the controller hands over to `edge` once the edge
  # serves the mesh domain (TLS handover; mesh-control.service reconcile).
  # The final listener is the same :8081, so peers joined now keep working.
  MESH_BOOT_TLS="$MESH_TLS"; [ "$MESH_TLS" = edge ] && MESH_BOOT_TLS=none
  MESH_LISTEN="${docker0:-172.17.0.1}:${MESH_CONTROL_HTTP_PORT}"   # the edge's upstream (docker0)
  cfg="$(mesh_control_config "$MESH_DOMAIN" "$MESH_BOOT_TLS" "$listen" "$MESH_AUTH_SECRET" "$MESH_ENCRYPTION_KEY")"

  if ! docker ps --format '{{.Names}}' | grep -qx "$MESH_CONTROL_CONTAINER"; then
    if docker ps -a --format '{{.Names}}' | grep -qx "$MESH_CONTROL_CONTAINER"; then
      docker start "$MESH_CONTROL_CONTAINER" >/dev/null 2>&1 || docker rm -f "$MESH_CONTROL_CONTAINER" >/dev/null 2>&1 || true
    fi
  fi
  if ! docker ps --format '{{.Names}}' | grep -qx "$MESH_CONTROL_CONTAINER"; then
    say "Starting the mesh control plane (NetBird ${MESH_CONTROL_IMAGE%%@*}) at ${MESH_DOMAIN}…"
    if [ "$MESH_TLS" = letsencrypt ]; then
      ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE '(^|:)(80|443)$' && die "--mesh-tls letsencrypt needs TCP 80 and 443 free on this host (something is listening). Use --mesh-tls edge or free them."
    fi
    ss -lun 2>/dev/null | awk '{print $4}' | grep -qE '(^|:)3478$' && die "UDP 3478 (STUN) is in use on this host; the mesh control plane needs it."
    docker pull "$MESH_CONTROL_IMAGE" >/dev/null 2>&1 || warn "could not pull $MESH_CONTROL_IMAGE; using a local copy if present."
    # Setup (owner + first token) is only possible while the store is empty.
    local pat_env=""; [ -n "${NB_SERVICE_TOKEN:-}" ] || pat_env="-e NB_SETUP_PAT_ENABLED=true"
    # shellcheck disable=SC2086
    docker run -d --name "$MESH_CONTROL_CONTAINER" --network host --restart unless-stopped \
      --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
      --tmpfs /run/swarmy-mesh:rw,noexec,nosuid,size=1m,mode=0700 \
      -v swarmy-mesh-control:/var/lib/netbird \
      -e NB_DISABLE_GEOLOCATION=true -e GOMEMLIMIT=192MiB $pat_env \
      --label swarmy.managed=true --label swarmy.role=mesh-control --label "swarmy.mesh.control.image=${MESH_CONTROL_IMAGE}" \
      --entrypoint sh "$MESH_CONTROL_IMAGE" \
      -c 'while [ ! -s /run/swarmy-mesh/config.yaml ]; do sleep 0.2; done; if [ -s /run/swarmy-mesh/extra-ca.pem ]; then cat /etc/ssl/certs/ca-certificates.crt /run/swarmy-mesh/extra-ca.pem > /run/swarmy-mesh/ca.pem; export SSL_CERT_FILE=/run/swarmy-mesh/ca.pem; fi; exec /go/bin/netbird-server --config /run/swarmy-mesh/config.yaml' \
      >/dev/null || die "failed to start the mesh control plane."
  fi
  # The config (relay secret, store key) lives in the container's tmpfs, never on
  # its spec. The agent keeps the same copy (0600, its own volume) so it can put
  # it back after a restart even while the controller is unreachable.
  if ! docker exec "$MESH_CONTROL_CONTAINER" test -s /run/swarmy-mesh/config.yaml 2>/dev/null; then
    # A private CA for swarmy's own https issuer (NetBird only accepts https issuers).
    if [ -n "${MESH_EXTRA_CA:-}" ] && [ -s "$MESH_EXTRA_CA" ]; then
      docker exec -i "$MESH_CONTROL_CONTAINER" sh -c 'umask 077; cat > /run/swarmy-mesh/extra-ca.pem' < "$MESH_EXTRA_CA" \
        || die "could not hand the mesh control plane its extra CA."
    fi
    printf '%s\n' "$cfg" | docker exec -i "$MESH_CONTROL_CONTAINER" sh -c 'umask 077; cat > /run/swarmy-mesh/config.yaml.tmp && mv /run/swarmy-mesh/config.yaml.tmp /run/swarmy-mesh/config.yaml' \
      || die "could not hand the mesh control plane its config."
  fi
  printf '%s\n' "$cfg" | docker run --rm -i -v swarmy-agent:/s --entrypoint sh "$MESH_CONTROL_IMAGE" -c \
    "umask 077; mkdir -p /s/mesh-control && cat > /s/mesh-control/config.yaml && printf '%s\n' '${MESH_CONTROL_IMAGE}' > /s/mesh-control/image && printf '%s' '{\"NB_DISABLE_GEOLOCATION\":\"true\",\"GOMEMLIMIT\":\"192MiB\"}' > /s/mesh-control/env.json" \
    || warn "could not give the agent its copy of the mesh config; it takes it from the controller instead."
  if [ -n "${MESH_EXTRA_CA:-}" ] && [ -s "$MESH_EXTRA_CA" ]; then
    docker run --rm -i -v swarmy-agent:/s --entrypoint sh "$MESH_CONTROL_IMAGE" -c 'umask 077; cat > /s/mesh-control/extra-ca.pem' < "$MESH_EXTRA_CA" || true
  fi
  mesh_control_firewall
  for i in $(seq 1 90); do mesh_control_healthy && break; sleep 1; done
  mesh_control_healthy || die "the mesh control plane did not become healthy (docker logs ${MESH_CONTROL_CONTAINER})."
  if [ "$MESH_TLS" = letsencrypt ]; then
    say "Waiting for the mesh certificate for ${MESH_DOMAIN}…"
    for i in $(seq 1 60); do curl -fsS -m 4 "https://${MESH_DOMAIN}/api/instance" >/dev/null 2>&1 && break; sleep 3; done
  fi
  ok "mesh control plane healthy."

  # Claim it once: the owner (break-glass, vault-held) exists only in NetBird's
  # own IdP; its first sign-in creates the account (see nb_owner_jwt), and that
  # JWT mints a service user token for swarmy. No setup PAT ever exists.
  if [ -z "${NB_SERVICE_TOKEN:-}" ]; then
    local jwt svc tok owner_email="mesh-owner@${CLUSTER_NAME}.swarmy.local"
    if curl -fsS -m 10 "${NB_ADMIN_URL}/api/instance" 2>/dev/null | grep -q '"setup_required":true'; then
      curl -fsS -m 20 -X POST "${NB_ADMIN_URL}/api/setup" -H 'Content-Type: application/json' \
        -d "{\"email\":\"${owner_email}\",\"name\":\"swarmy break-glass\",\"password\":\"${MESH_OWNER_PASSWORD}\"}" >/dev/null \
        || die "could not claim the mesh control plane (docker logs ${MESH_CONTROL_CONTAINER})."
    fi
    state_set MESH_OWNER_EMAIL "$owner_email"
    jwt="$(nb_owner_jwt "$owner_email" "$MESH_OWNER_PASSWORD")" || jwt=""
    [ -n "$jwt" ] || die "could not sign in to the mesh control plane as its owner (docker logs ${MESH_CONTROL_CONTAINER})."
    NB_AUTH_SCHEME=Bearer nb_api GET /users/current '' "$jwt" >/dev/null || die "the mesh control plane refused the owner's sign-in token."
    svc="$(NB_AUTH_SCHEME=Bearer nb_api POST /users '{"name":"swarmy-controller","role":"admin","is_service_user":true,"auto_groups":[]}' "$jwt" | json_field id)"
    tok="$(NB_AUTH_SCHEME=Bearer nb_api POST "/users/${svc}/tokens" '{"name":"swarmy-controller","expires_in":365}' "$jwt" | json_field plain_token)"
    [ -n "$tok" ] || die "could not mint the swarmy service token on the mesh control plane."
    state_set NB_SERVICE_TOKEN "$tok"
    ok "mesh control plane claimed (owner signed in once; service token minted)."
  fi

  # Default deny from the start: the combined server always creates an
  # All <-> All "Default" policy (disableDefaultPolicy is ignored), so it goes
  # before any peer joins. Servers get their own group + nodes <-> nodes.
  local pols def nodes_policy
  pols="$(nb_api GET /policies || true)"
  def="$(printf '%s' "$pols" | json_id_named Default)" || def=""
  if [ -n "$def" ] && printf '%s' "$pols" | grep -q '"name":"All"'; then nb_api DELETE "/policies/${def}" >/dev/null && ok "removed NetBird's allow-all Default policy."; fi
  NB_NODES_GROUP_ID="$( { nb_api GET /groups || true; } | json_id_named "swarmy:${CLUSTER_NAME}:nodes")"
  if [ -z "$NB_NODES_GROUP_ID" ]; then
    NB_NODES_GROUP_ID="$(nb_api POST /groups "{\"name\":\"swarmy:${CLUSTER_NAME}:nodes\"}" | json_field id)"
  fi
  [ -n "$NB_NODES_GROUP_ID" ] || die "could not create the swarmy:${CLUSTER_NAME}:nodes group."
  nodes_policy="swarmy-${CLUSTER_NAME}-nodes"
  if ! printf '%s' "$pols" | grep -qF "\"name\":\"${nodes_policy}\""; then
    nb_api POST /policies "{\"name\":\"${nodes_policy}\",\"enabled\":true,\"rules\":[{\"name\":\"${nodes_policy}\",\"enabled\":true,\"action\":\"accept\",\"bidirectional\":true,\"protocol\":\"all\",\"sources\":[\"${NB_NODES_GROUP_ID}\"],\"destinations\":[\"${NB_NODES_GROUP_ID}\"]}]}" >/dev/null \
      || die "could not create the nodes policy."
  fi

  # Join itself (hairpin to its own name works). Behind the edge the client
  # talks to the local listener, which is up before any Caddy exists.
  MESH_IP="$(mesh_ip)"
  if [ -n "$MESH_IP" ]; then ok "mesh already up on ${NB_INTERFACE} (${MESH_IP})."; return 0; fi
  # Behind the edge, node #1's client dials the local listener: up before any
  # edge exists, and still the same listener after the handover.
  client_url="$NB_MANAGEMENT_URL"; [ "$MESH_TLS" = edge ] && client_url="http://${MESH_LISTEN}"
  local key key_file="$STATE_DIR/netbird-setup-key" ca_args=()
  # A private CA (SWARMY_MESH_EXTRA_CA) for the https control plane: the client
  # trusts it next to its system roots (Go reads every file in SSL_CERT_DIR).
  if [ -n "${MESH_EXTRA_CA:-}" ] && [ -s "$MESH_EXTRA_CA" ]; then
    install -m 0644 "$MESH_EXTRA_CA" "$STATE_DIR/mesh-ca.pem"
    ca_args=(-v "$STATE_DIR/mesh-ca.pem:/etc/swarmy/ca/mesh-ca.pem:ro" -e SSL_CERT_DIR=/etc/ssl/certs:/etc/swarmy/ca)
  fi
  key="$(nb_setup_key one-off 1 3600 "swarmy node #1 $(hostname)")"
  docker pull "$NETBIRD_IMAGE" >/dev/null 2>&1 || warn "could not pull $NETBIRD_IMAGE; using local copy if present."
  docker rm -f "$NETBIRD_CONTAINER" >/dev/null 2>&1 || true
  state_dir; printf '%s\n' "$key" > "$key_file"; chmod 600 "$key_file"
  docker run -d --name "$NETBIRD_CONTAINER" --restart unless-stopped --network host \
    --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
    --cap-add NET_ADMIN --cap-add SYS_ADMIN --cap-add SYS_RESOURCE --device /dev/net/tun \
    -v "${NETBIRD_CONTAINER}:/var/lib/netbird" \
    -v "${key_file}:/etc/netbird/setup-key:ro" \
    -e NB_SETUP_KEY_FILE=/etc/netbird/setup-key -e NB_MANAGEMENT_URL="$client_url" -e NB_INTERFACE_NAME="$NB_INTERFACE" \
    ${ca_args[@]+"${ca_args[@]}"} \
    "$NETBIRD_IMAGE" >/dev/null || die "failed to start the NetBird client."
  for i in $(seq 1 60); do MESH_IP="$(mesh_ip)"; [ -n "$MESH_IP" ] && break; sleep 1; done
  [ -n "$MESH_IP" ] || die "NetBird did not come up within 60s (docker logs ${NETBIRD_CONTAINER})."
  ok "this host joined its own mesh (${MESH_IP})."
}

ensure_mesh_node1() {
  [ "$MESH" = none ] && return 0
  if [ "$MESH" = swarmy ]; then ensure_mesh_control; return; fi
  MESH_IP="$(mesh_ip)"
  if [ -n "$MESH_IP" ]; then ok "mesh already up on ${NB_INTERFACE} (${MESH_IP})."; return 0; fi
  [ -n "${NB_SERVICE_TOKEN:-}" ] || die "--mesh ${MESH} needs NB_SERVICE_TOKEN (a NetBird Personal Access Token)."
  local api="${NB_MANAGEMENT_URL%/}" key i
  say "Joining the NetBird mesh before forming the swarm…"
  key="$(nb_setup_key one-off 1 3600 "swarmy node #1 $(hostname)")"
  docker pull "$NETBIRD_IMAGE" >/dev/null 2>&1 || warn "could not pull $NETBIRD_IMAGE; using local copy if present."
  docker rm -f "$NETBIRD_CONTAINER" >/dev/null 2>&1 || true
  # The setup key rides a root-only 0600 file mounted read-only and read by
  # `netbird up` via NB_SETUP_KEY_FILE (--setup-key-file) — never -e, which
  # would keep it in `docker inspect` / config.v2.json. It stays on disk (a
  # one-off, 1h key, already spent) so a container restart still finds the mount.
  local key_file="$STATE_DIR/netbird-setup-key"
  state_dir; printf '%s\n' "$key" > "$key_file"; chmod 600 "$key_file"
  # Same name/volume the agent's applyMesh uses, so it adopts this client.
  docker run -d --name "$NETBIRD_CONTAINER" --restart unless-stopped --network host \
    --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
    --cap-add NET_ADMIN --cap-add SYS_ADMIN --cap-add SYS_RESOURCE --device /dev/net/tun \
    -v "${NETBIRD_CONTAINER}:/var/lib/netbird" \
    -v "${key_file}:/etc/netbird/setup-key:ro" \
    -e NB_SETUP_KEY_FILE=/etc/netbird/setup-key -e NB_MANAGEMENT_URL="$api" -e NB_INTERFACE_NAME="$NB_INTERFACE" \
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
      # A mesh means people's laptops may route into overlays: keep the pool clear
      # of the 10.0.x LANs they sit on (only settable at init). --default-addr-pool wins.
      local pool="${ADDR_POOL:-}"
      [ -n "$pool" ] || [ "$MESH" != swarmy ] || pool="$(mesh_addr_pool "${MESH_DOMAIN:-$(hostname)}")"
      # shellcheck disable=SC2086
      docker swarm init --advertise-addr "$adv" --data-path-addr "$adv" ${pool:+--default-addr-pool "$pool"} >/dev/null || die "docker swarm init failed."
      [ -z "$pool" ] || state_set SWARM_ADDR_POOL "$pool"
    elif [ -n "${ADDR_POOL:-}" ]; then
      docker swarm init --advertise-addr "$adv" --default-addr-pool "$ADDR_POOL" >/dev/null || die "docker swarm init failed."
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
  # --mesh swarmy: what the controller needs to keep running NetBird (sealed
  # into swarm-kv by the bootstrap seed). `{}` otherwise, so the stack can
  # reference it unconditionally.
  if [ "$MESH" = swarmy ]; then
    local ca_json=""
    if [ -n "${MESH_EXTRA_CA:-}" ] && [ -s "$MESH_EXTRA_CA" ]; then
      ca_json=",\"extraCaPem\":\"$(awk '{printf "%s\\n", $0}' "$MESH_EXTRA_CA")\""
    fi
    secret_put mesh_control "{\"authSecret\":\"${MESH_AUTH_SECRET}\",\"encryptionKey\":\"${MESH_ENCRYPTION_KEY}\",\"ownerEmail\":\"${MESH_OWNER_EMAIL:-}\",\"ownerPassword\":\"${MESH_OWNER_PASSWORD}\"${ca_json}}"
  else
    secret_put mesh_control '{}'
  fi
  # Controller store (resilience P3): `{}` = not replicated yet. The controller
  # mints swarmy_control_store.<ts> when replication is switched on.
  secret_put swarmy_control_store.0 '{}'
  ok "secrets present."
}

# The live controller's store secret + placement, so a re-run (upgrade) keeps
# replication on and the controller floating instead of re-pinning it to an
# empty volume on this host.
controller_store_secret() {
  local cur
  cur="$(docker service inspect "${STACK_NAME}_controller" \
    -f '{{range .Spec.TaskTemplate.ContainerSpec.Secrets}}{{if eq .File.Name "control_store"}}{{.SecretName}}{{end}}{{end}}' 2>/dev/null || true)"
  if [ -n "$cur" ] && docker secret inspect "$cur" >/dev/null 2>&1; then printf '%s' "$cur"; else printf '%s' swarmy_control_store.0; fi
}
controller_placement() {
  if docker service inspect "${STACK_NAME}_controller" \
    -f '{{range .Spec.TaskTemplate.Placement.Constraints}}{{println .}}{{end}}' 2>/dev/null | tr -d ' ' | grep -qx 'node.role==manager'; then
    printf '%s' 'node.role == manager'
  else
    printf '%s' "node.hostname == ${NODE_HOSTNAME}"
  fi
}

# ════════════════════════════════════════════════════════════════════════════
# Phase 8 — deploy control plane
# ════════════════════════════════════════════════════════════════════════════
write_stack_file() {  # emit the chosen stack file to $STATE_DIR (self-contained curl|sh path)
  local dst="$STATE_DIR/$STACK_FILE" src
  for src in "deploy/$STACK_FILE" "$(dirname "$0")/../deploy/$STACK_FILE"; do
    if [ -f "$src" ]; then cp "$src" "$dst"; printf '%s' "$dst"; return; fi
  done
  # curl | bash: no checkout on disk — fetch the stack file for the same ref.
  local url="${SWARMY_RAW_BASE}/deploy/$STACK_FILE"
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
  create_overlay "$INTEGRATIONS_NET" integrations
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
  local mesh_mode="" mesh_tls_env=""
  if [ "$MESH" = swarmy ]; then
    mesh_mode="managed-by-swarmy"
    mesh_tls_env="$(mesh_tls_env "$MESH_TLS" "$MESH_LISTEN" "${MESH_PUBLIC_PORT:-}")"
  fi
  # Caddy reaches the controller over swarmy-control: trust that subnet's
  # X-Forwarded-For so auth rate limits see real clients, not Caddy's address.
  # (Never the shared `swarmy` subnet — any routed app could spoof XFF from it.)
  if [ -n "$DASHBOARD_DOMAIN" ]; then
    trusted_proxies="$(docker network inspect "$CONTROL_NET" -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null | xargs || true)"
    [ -z "$trusted_proxies" ] || trusted_proxies="127.0.0.0/8 ::1/128 $trusted_proxies"
  fi
  local store_secret placement
  store_secret="$(controller_store_secret)"
  placement="$(controller_placement)"
  say "Deploying the swarmy control plane (${placement})…"
  SWARMY_IMAGE="$IMAGE" \
  SWARMY_PUBLIC_URL="$PUBLIC_URL" \
  SWARMY_DASHBOARD_DOMAIN="$DASHBOARD_DOMAIN" \
  SWARMY_DIRECT_URL="$LOGIN_URL" \
  SWARMY_DIRECT_HOSTS="$(host_addresses "${PUBLIC_IP:-}")" \
  SWARMY_TRUSTED_PROXIES="$trusted_proxies" \
  SWARMY_ADMIN_EMAIL="$(case "$ADMIN_EMAIL" in *@*) printf '%s' "$ADMIN_EMAIL" ;; esac)" \
  SWARMY_ADMIN_USERNAME="$(case "$ADMIN_EMAIL" in *@*) ;; *) printf '%s' "$ADMIN_EMAIL" ;; esac)" \
  SWARMY_SWARM_ID="$SWARM_ID" \
  SWARMY_MANAGER_ADDR="$SWARM_MANAGER_ADDR" \
  SWARMY_PUBLISH_PORT="$PUBLISH_PORT" \
  SWARMY_ALLOW_SIGNUP="$ALLOW_SIGNUP" \
  SWARMY_RELEASE_PUBKEY="$RELEASE_PUBKEY" \
  SWARMY_PLATFORM_FEED_URL="$PLATFORM_FEED_URL" \
  SWARMY_NODE_HOSTNAME="$NODE_HOSTNAME" \
  SWARMY_CONTROLLER_PLACEMENT="$placement" \
  SWARMY_CONTROL_STORE_SECRET="$store_secret" \
  SWARMY_CONTROLLER_LEASE="$(docker service inspect "${STACK_NAME}_controller" -f '{{index .Spec.Labels "swarmy.controller.lease"}}' 2>/dev/null || true)" \
  SWARMY_MESH_DRIVER="$mesh_driver" \
  SWARMY_MESH_MANAGEMENT_URL="${NB_MANAGEMENT_URL:-}" \
  SWARMY_MESH_MODE="$mesh_mode" \
  SWARMY_MESH_DOMAIN="${MESH_DOMAIN:-}" \
  SWARMY_MESH_TLS="$mesh_tls_env" \
  SWARMY_MESH_CLUSTER="${CLUSTER_NAME:-}" \
  SWARMY_MESH_CONTROL_HOSTNAME="${NODE_HOSTNAME:-}" \
  SWARMY_MESH_ADMIN_URL="$( [ "$MESH" = swarmy ] && [ "$MESH_TLS" = edge ] && printf 'http://%s' "${MESH_LISTEN:-}" )" \
    docker stack deploy --with-registry-auth -c "$f" "$STACK_NAME" >/dev/null \
    || die "docker stack deploy failed."
  say "Waiting for the controller to become healthy…"
  local i
  for i in $(seq 1 120); do
    curl -fsS -m 2 "http://localhost:${PUBLISH_PORT}/health" >/dev/null 2>&1 && { ok "controller healthy at http://localhost:${PUBLISH_PORT}."; return; }
    # A floating (replicated) controller may run on another manager: its task
    # being up is as good as a local health hit.
    if [ "$placement" = 'node.role == manager' ] \
      && docker service ps "${STACK_NAME}_controller" --filter desired-state=running --format '{{.CurrentState}}' 2>/dev/null | grep -q '^Running' ; then
      ok "controller running on $(docker service ps "${STACK_NAME}_controller" --filter desired-state=running --format '{{.Node}}' | head -1) (floating)."
      return
    fi
    sleep 2
  done
  die "controller did not become healthy in time — check 'docker service logs ${STACK_NAME}_controller'."
}

# ════════════════════════════════════════════════════════════════════════════
# Phase 10 — enrol THIS host as node #1 (agent on the overlay)
# ════════════════════════════════════════════════════════════════════════════
# write_agent_env — (re)write SWARMY_JOIN_TOKEN into the 0600 agent env file,
# keeping any other keys a repair one-liner may have written there.
write_agent_env() {
  local tmp
  mkdir -p "$(dirname "$AGENT_ENV_FILE")"
  tmp="$(mktemp "$(dirname "$AGENT_ENV_FILE")/.agent-env.XXXXXX")"
  { grep -v '^SWARMY_JOIN_TOKEN=' "$AGENT_ENV_FILE" 2>/dev/null || true; } > "$tmp"
  printf 'SWARMY_JOIN_TOKEN=%s\n' "$BOOTSTRAP_JOIN_TOKEN" >> "$tmp"
  chmod 600 "$tmp"; mv "$tmp" "$AGENT_ENV_FILE"
}

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
  # The join token rides a root-only 0600 env file mounted read-only at the
  # path the agent loads itself (apps/agent/src/env.ts) — never -e, which keeps
  # it in `docker inspect` for anyone on the socket. Mirrors installer.ts.
  write_agent_env
  docker run -d --name "$AGENT_CONTAINER" --restart unless-stopped \
    --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
    --network "$CONTROL_NET" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v swarmy-agent:/var/lib/swarmy \
    -v "$AGENT_ENV_FILE":/etc/swarmy/agent.env:ro \
    -e AGENT_WS_URL="ws://${CONTROLLER_DNS}/agent/ws" \
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
  if [ "$MESH" = swarmy ]; then
    ok "Mesh control plane runs in swarmy at $(mesh_public_url "$MESH_DOMAIN" "$MESH_TLS") (cluster ${CLUSTER_NAME}). New nodes join it before the swarm; people access is off until an admin turns it on (Networking → Mesh)."
    [ "$MESH_TLS" != edge ] || say "  Behind swarmy's Caddy edge: ${MESH_DOMAIN} needs a DNS A record → ${PUBLIC_IP:-<public-ip>} (sslip.io names resolve by themselves)."
    return 0
  fi
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
    local k join_mgmt="${NB_MANAGEMENT_URL%/}"
    if [ "$MESH" = swarmy ] && [ "$MESH_TLS" = edge ]; then
      # Hand out the final URL once the handover is done; until then, the
      # bootstrap listener (which stays served after it) so the line works now.
      if mesh_wait_handover; then ok "mesh TLS handed over to swarmy's edge (${join_mgmt})."
      else
        join_mgmt="http://${MESH_DOMAIN}:${MESH_CONTROL_HTTP_PORT}"
        warn "the edge isn't serving ${MESH_DOMAIN} yet (DNS/certificate); the line below uses ${join_mgmt}, which keeps working after the handover."
      fi
    fi
    k="$(nb_setup_key reusable 5 86400 'swarmy bootstrap one-liner')" || k=""
    [ -z "$k" ] || mesh_env="SWARMY_MESH_SETUP_KEY=$k SWARMY_MESH_MANAGEMENT_URL=${join_mgmt} SWARMY_MESH_DRIVER=netbird "
    if [ -n "$k" ] && [ -n "${MESH_EXTRA_CA:-}" ] && [ -s "$MESH_EXTRA_CA" ]; then
      mesh_env="${mesh_env}SWARMY_MESH_CA_B64=$(base64 -w0 "$MESH_EXTRA_CA" 2>/dev/null || base64 "$MESH_EXTRA_CA" | tr -d '\n') "
    fi
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
  for s in swarmy_secret_key better_auth_secret admin_password bootstrap_join_token swarm_worker_token swarm_manager_token mesh_service_token mesh_control \
    $(docker secret ls --format '{{.Name}}' 2>/dev/null | grep '^swarmy_control_store\.' || true); do
    docker secret rm "$s" >/dev/null 2>&1 || true
  done
  ok "removed. The swarmy-data volume (the controller store) and $STATE_FILE are preserved; delete them manually to wipe state."
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
  marker_done docker   || { with_public_umask ensure_docker; marker_set docker; }
  with_public_umask ensure_docker_log_opts   # idempotent; 022 keeps daemon.json/journald drop-ins 0644
  with_public_umask ensure_docker_registry_mirror   # idempotent: Docker Hub via the swarm's pull-through cache
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
