#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# verify-networking.sh — prove swarmy's service-to-service network model on a
# LIVE swarm. Run on a swarm MANAGER of a swarmy install:
#
#   sudo bash scripts/verify-networking.sh            # run + clean up
#   sudo bash scripts/verify-networking.sh --keep     # leave test objects behind
#   sudo bash scripts/verify-networking.sh --image busybox:1.36
#
# What it proves (one line per check: PASS|FAIL|WARN|SKIP|INFO  <check>  <detail>):
#
#   Layout (read-only)
#     - `swarmy-control` overlay exists, is encrypted, and ONLY platform services
#       join it (controller, controller Postgres, ClickHouse, edge Caddy, OTel
#       collector, cloudflared, the node #1 agent container).
#     - the controller + its Postgres are NOT on the user-joinable `swarmy`
#       overlay (the pre-fix layout let any routed app reach / impersonate them).
#     - no non-platform service carries network ALIASES on `swarmy` or
#       `swarmy-control` (an alias on a shared network can shadow a platform name).
#     - overlay MTU vs the mesh interface (wt0 / tailscale0 / wg0): an overlay
#       whose MTU is unset or > (mesh MTU - 50 VXLAN bytes) can black-hole
#       large packets between mesh nodes.
#
#   Functional (creates `swarmy-nettest-*` objects labelled swarmy.nettest=true,
#   always removed on exit unless --keep)
#     1. within an app: short name `web`, `tasks.web`, HTTP, a ~2 MB transfer
#        (MTU black-hole detector) — cross-node when the swarm has >1 node.
#     2. between apps: app A can NOT resolve app B's services (isolation).
#     3. connected apps: a pairing overlay makes `api.<appB>` and `<appB>_api`
#        reachable from app A (swarmy's real ones are `swarmy-link-<hash>`).
#     4. managed resource: an app attached to `<app>_db-net` reaches
#        `<app>_db-primary:5432`; an unattached app can't even resolve it.
#     5. SECURITY: a routed-app-like service on `swarmy` can NOT resolve or
#        connect to the controller or its Postgres/ClickHouse.
#     6. the same service CAN still reach the edge (informational).
#
# Exit status: 1 when any check FAILs, else 0. No jq needed.
# ════════════════════════════════════════════════════════════════════════════
set -euo pipefail

IMAGE="busybox:1.36"
KEEP=0
PREFIX="swarmy-nettest"
LABEL="swarmy.nettest=true"
WAIT_SECS=90
EDGE_NET="swarmy"
CONTROL_NET="swarmy-control"

while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1; shift ;;
    --image) IMAGE="${2:?--image needs a value}"; shift 2 ;;
    --image=*) IMAGE="${1#--image=}"; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

PASS=0; FAIL=0; WARN=0; SKIP=0
report() { # report STATUS CHECK DETAIL
  local st="$1" check="$2" detail="${3:-}"
  printf '%-5s %-46s %s\n' "$st" "$check" "$detail"
  case "$st" in
    PASS) PASS=$((PASS + 1)) ;;
    FAIL) FAIL=$((FAIL + 1)) ;;
    WARN) WARN=$((WARN + 1)) ;;
    SKIP) SKIP=$((SKIP + 1)) ;;
  esac
}
say() { printf '\n== %s\n' "$*"; }

# ── preflight ───────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || { echo "docker not found" >&2; exit 2; }
if [ "$(docker info -f '{{.Swarm.ControlAvailable}}' 2>/dev/null || echo false)" != "true" ]; then
  echo "this host is not a swarm manager — run it on a manager node" >&2
  exit 2
fi
SELF="$(docker info -f '{{.Swarm.NodeID}}')"
# A second Active+Ready node (for cross-node checks), if any.
REMOTE=""
while read -r id avail status; do
  [ "$id" = "$SELF" ] && continue
  if [ "$avail" = "Active" ] && [ "$status" = "Ready" ]; then REMOTE="$id"; break; fi
done < <(docker node ls --format '{{.ID}} {{.Availability}} {{.Status}}')
if [ -n "$REMOTE" ]; then
  SERVER_CONSTRAINT="node.id==$REMOTE"
  CROSS="cross-node"
else
  SERVER_CONSTRAINT="node.id==$SELF"
  CROSS="single-node"
fi
LOCAL_CONSTRAINT="node.id==$SELF"

# ── helpers ─────────────────────────────────────────────────────────────────
net_id() { docker network inspect -f '{{.Id}}' "$1" 2>/dev/null || true; }
net_opts() { docker network inspect -f '{{range $k, $v := .Options}}{{$k}}={{$v}} {{end}}' "$1" 2>/dev/null || true; }
net_mtu() { net_opts "$1" | tr ' ' '\n' | sed -n 's/^com\.docker\.network\.driver\.mtu=//p' | head -n1; }

# One line per service: name|stack|system|<netTarget>=<aliases>;...
service_table() {
  local ids
  ids="$(docker service ls -q)"
  [ -n "$ids" ] || return 0
  # shellcheck disable=SC2086
  docker service inspect --format \
    '{{.Spec.Name}}|{{index .Spec.Labels "com.docker.stack.namespace"}}|{{index .Spec.Labels "swarmy.system"}}|{{range .Spec.TaskTemplate.Networks}}{{.Target}}={{join .Aliases ","}};{{end}}' \
    $ids
}

# Service $1's network entries on network (name $2 / id $3): prints aliases, exit 0 when on it.
on_network() { # on_network LINE NETNAME NETID
  local nets="${1##*|}" entry target
  local IFS=';'
  for entry in $nets; do
    [ -n "$entry" ] || continue
    target="${entry%%=*}"
    if [ "$target" = "$2" ] || { [ -n "$3" ] && [ "$target" = "$3" ]; }; then
      printf '%s' "${entry#*=}"
      return 0
    fi
  done
  return 1
}

is_platform() { # is_platform NAME STACK SYSTEM
  [ "$2" = "swarmy" ] || [ "$2" = "swarmy-system" ] || [ "$3" = "true" ] && return 0
  case "$1" in
    swarmy_controller|swarmy_postgres|swarmy-clickhouse|swarmy-ingress-caddy|swarmy-otel-collector|swarmy-cloudflared) return 0 ;;
  esac
  return 1
}

wait_running() { # wait_running SERVICE — until a running task exists (bounded)
  local svc="$1" i state
  for i in $(seq 1 "$WAIT_SECS"); do
    state="$(docker service ps "$svc" --filter desired-state=running --format '{{.CurrentState}}' 2>/dev/null | head -n1 || true)"
    case "$state" in Running*) return 0 ;; esac
    sleep 1
  done
  echo "  ($svc did not reach Running within ${WAIT_SECS}s: ${state:-no task}; $(docker service ps "$svc" --no-trunc --format '{{.Error}}' 2>/dev/null | head -n1))" >&2
  return 1
}

container_of() { # container_of SERVICE — local container of its running task
  local svc="$1" task i cid
  for i in $(seq 1 "$WAIT_SECS"); do
    task="$(docker service ps "$svc" --filter desired-state=running --format '{{.ID}} {{.CurrentState}}' 2>/dev/null | awk '$2=="Running"{print $1; exit}')"
    if [ -n "$task" ]; then
      cid="$(docker ps -q --filter "label=com.docker.swarm.task.id=$(docker inspect -f '{{.ID}}' "$task" 2>/dev/null || echo "$task")" | head -n1)"
      [ -n "$cid" ] || cid="$(docker ps -q --filter "label=com.docker.swarm.service.name=$svc" --filter status=running | head -n1)"
      if [ -n "$cid" ]; then printf '%s' "$cid"; return 0; fi
    fi
    sleep 1
  done
  return 1
}

cexec() { # cexec SERVICE CMD — run CMD in the service's local container
  local cid
  cid="$(container_of "$1")" || return 125
  docker exec "$cid" sh -c "$2"
}

# >>> lookup_cmd (extracted by scripts/verify-networking-lookup.test.sh)
lookup_cmd() { # lookup_cmd NAME — in-container sh snippet printing NAME's IPs, one per line
  # Query swarm's embedded DNS for the name AS GIVEN. A bare `nslookup web`
  # appends the host's DNS search domain (copied into every container's
  # resolv.conf) and busybox never retries the bare name, so `web` "failed to
  # resolve" on any host with `search corp.example`. A trailing dot makes the
  # name absolute (no search list, no ndots); getent (glibc/musl images) is
  # preferred, else busybox nslookup asked 127.0.0.11 directly.
  local fq="$1"
  case "$fq" in *.) ;; *) fq="$fq." ;; esac
  printf '%s' "if command -v getent >/dev/null 2>&1; then getent hosts '$fq' | awk '{print \$1}'; else nslookup '$fq' 127.0.0.11 2>/dev/null | awk '/^Name:/{n=1; next} n && /^Address/{for (i=2; i<=NF; i++) if (\$i ~ /^[0-9a-fA-F]*[.:][0-9a-fA-F.:]+\$/) {print \$i; break}}'; fi"
}
# <<< lookup_cmd

resolves() { # resolves SERVICE NAME — exit 0 resolved, 1 not; the run aborts if SERVICE has no local container
  local rc=0
  cexec "$1" "$(lookup_cmd "$2") | grep -q ." >/dev/null 2>&1 || rc=$?
  if [ "$rc" = 125 ]; then
    report FAIL "exec into $1" "no local running container — negative checks would be meaningless"; exit 1
  fi
  return "$rc"
}

http_ok() { # http_ok SERVICE URL
  cexec "$1" "wget -q -T 5 -O - '$2' >/dev/null" >/dev/null 2>&1
}

tcp_ok() { # tcp_ok SERVICE HOST PORT
  cexec "$1" "nc -w 2 '$2' '$3' </dev/null >/dev/null 2>&1" >/dev/null 2>&1
}

mk_net() { # mk_net NAME — mirrors swarmy: overlay, attachable, MTU copied from the platform overlay
  local opt=()
  [ -n "${TEMPLATE_MTU:-}" ] && opt=(--opt "com.docker.network.driver.mtu=$TEMPLATE_MTU")
  docker network create -d overlay --attachable --label "$LABEL" "${opt[@]}" "$1" >/dev/null
}

SERVER_CMD='mkdir -p /www && echo "ok-$(hostname)" > /www/index.html && dd if=/dev/urandom of=/www/big bs=1024 count=2048 2>/dev/null && exec httpd -f -p "${PORT:-8080}" -h /www'

mk_server() { # mk_server NAME CONSTRAINT PORT NETSPEC...
  local name="$1" constraint="$2" port="$3"; shift 3
  local nets=() n
  for n in "$@"; do nets+=(--network "$n"); done
  docker service create -d -q --name "$name" --label "$LABEL" --container-label "$LABEL" \
    --constraint "$constraint" --env "PORT=$port" --restart-condition none "${nets[@]}" \
    "$IMAGE" sh -c "$SERVER_CMD" >/dev/null
}

mk_client() { # mk_client NAME NETSPEC...
  local name="$1"; shift
  local nets=() n
  for n in "$@"; do nets+=(--network "$n"); done
  docker service create -d -q --name "$name" --label "$LABEL" --container-label "$LABEL" \
    --constraint "$LOCAL_CONSTRAINT" --restart-condition none "${nets[@]}" \
    "$IMAGE" sleep 3600 >/dev/null
}

cleanup() {
  local svcs nets i
  svcs="$(docker service ls -q --filter "label=$LABEL" 2>/dev/null || true)"
  # shellcheck disable=SC2086
  [ -z "$svcs" ] || docker service rm $svcs >/dev/null 2>&1 || true
  for i in $(seq 1 30); do
    nets="$(docker network ls -q --filter "label=$LABEL" 2>/dev/null || true)"
    [ -n "$nets" ] || return 0
    # shellcheck disable=SC2086
    docker network rm $nets >/dev/null 2>&1 || true
    sleep 2
  done
  echo "note: some ${PREFIX} networks are still in use; remove with: docker network ls --filter label=$LABEL" >&2
}
on_exit() {
  local rc=$?
  if [ "$KEEP" = 1 ]; then
    echo "--keep: leaving ${PREFIX}-* services/networks in place (docker service ls --filter label=$LABEL)"
  else
    say "Cleaning up ${PREFIX}-* objects"
    cleanup
  fi
  exit "$rc"
}

# ════════════════════════════════════════════════════════════════════════════
say "Layout checks (read-only)"
EDGE_ID="$(net_id "$EDGE_NET")"
CTRL_ID="$(net_id "$CONTROL_NET")"
[ -n "$EDGE_ID" ] && report PASS "overlay '$EDGE_NET' exists" "${EDGE_ID:0:12}" \
  || report FAIL "overlay '$EDGE_NET' exists" "missing — is this a swarmy install?"
if [ -n "$CTRL_ID" ]; then
  report PASS "overlay '$CONTROL_NET' exists" "${CTRL_ID:0:12}"
  if net_opts "$CONTROL_NET" | tr ' ' '\n' | grep -q '^encrypted'; then
    report PASS "'$CONTROL_NET' is encrypted" ""
  else
    report WARN "'$CONTROL_NET' is encrypted" "no 'encrypted' option — control traffic crosses nodes in clear VXLAN"
  fi
else
  report FAIL "overlay '$CONTROL_NET' exists" "missing — pre-isolation layout; re-run the installer to migrate"
fi

TABLE="$(service_table)"
ctrl_members=""; ctrl_offenders=""; alias_offenders=""
ctl_on_edge=""; seen_controller=0
while IFS= read -r line; do
  [ -n "$line" ] || continue
  name="${line%%|*}"; rest="${line#*|}"; stack="${rest%%|*}"; rest="${rest#*|}"; system="${rest%%|*}"
  [ "$name" = "swarmy_controller" ] && seen_controller=1
  if [ -n "$CTRL_ID" ] && aliases="$(on_network "$line" "$CONTROL_NET" "$CTRL_ID")"; then
    ctrl_members="$ctrl_members $name"
    if ! is_platform "$name" "$stack" "$system"; then ctrl_offenders="$ctrl_offenders $name"; fi
    if [ -n "$aliases" ] && ! is_platform "$name" "$stack" "$system"; then
      alias_offenders="$alias_offenders $name@$CONTROL_NET[$aliases]"
    fi
  fi
  if [ -n "$EDGE_ID" ] && aliases="$(on_network "$line" "$EDGE_NET" "$EDGE_ID")"; then
    case "$name" in swarmy_controller|swarmy_postgres) ctl_on_edge="$ctl_on_edge $name" ;; esac
    if [ -n "$aliases" ] && ! is_platform "$name" "$stack" "$system"; then
      alias_offenders="$alias_offenders $name@$EDGE_NET[$aliases]"
    fi
  fi
done <<<"$TABLE"

if [ -n "$CTRL_ID" ]; then
  report INFO "'$CONTROL_NET' members" "${ctrl_members:- (none)}"
  case " $ctrl_members " in
    *" swarmy_controller "*) report PASS "controller on '$CONTROL_NET'" "" ;;
    *) if [ "$seen_controller" = 1 ]; then report FAIL "controller on '$CONTROL_NET'" "swarmy_controller is not attached"; else report SKIP "controller on '$CONTROL_NET'" "no swarmy_controller service (dev controller?)"; fi ;;
  esac
  if [ -n "$ctrl_offenders" ]; then
    report FAIL "only platform services on '$CONTROL_NET'" "user services attached:$ctrl_offenders"
  else
    report PASS "only platform services on '$CONTROL_NET'" ""
  fi
  if docker ps --format '{{.Names}}' | grep -qx swarmy-agent; then
    if docker inspect swarmy-agent --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' | tr ' ' '\n' | grep -qx "$CONTROL_NET"; then
      report PASS "agent container on '$CONTROL_NET'" ""
    else
      report FAIL "agent container on '$CONTROL_NET'" "swarmy-agent can't reach swarmy_controller once it leaves '$EDGE_NET' — re-run the installer"
    fi
  else
    report SKIP "agent container on '$CONTROL_NET'" "no swarmy-agent container on this host (systemd agent?)"
  fi
fi
if [ -n "$ctl_on_edge" ]; then
  report FAIL "control plane off '$EDGE_NET'" "still attached:$ctl_on_edge — any routed app can reach/impersonate them. Fix: re-run the installer (moves them to '$CONTROL_NET')"
else
  report PASS "control plane off '$EDGE_NET'" ""
fi
if [ -n "$alias_offenders" ]; then
  report FAIL "no user aliases on shared overlays" "$alias_offenders"
else
  report PASS "no user aliases on shared overlays" ""
fi

say "MTU"
TEMPLATE_MTU="$(net_mtu "$EDGE_NET")"
for n in "$EDGE_NET" "$CONTROL_NET"; do
  [ -n "$(net_id "$n")" ] || continue
  m="$(net_mtu "$n")"
  report INFO "MTU '$n'" "${m:-unset (1500 default)}"
done
MESH_IF=""; MESH_MTU=""
for ifc in wt0 tailscale0 wg0; do
  if [ -r "/sys/class/net/$ifc/mtu" ]; then MESH_IF="$ifc"; MESH_MTU="$(cat "/sys/class/net/$ifc/mtu")"; break; fi
done
if [ -n "$MESH_IF" ]; then
  max=$((MESH_MTU - 50))
  report INFO "mesh interface" "$MESH_IF mtu=$MESH_MTU → overlay MTU must be ≤ $max"
  for n in "$EDGE_NET" "$CONTROL_NET"; do
    [ -n "$(net_id "$n")" ] || continue
    m="$(net_mtu "$n")"
    if [ -z "$m" ] || [ "$m" -gt "$max" ]; then
      report WARN "MTU '$n' fits the mesh" "${m:-unset} > $max: large packets between mesh nodes can fragment or black-hole"
    else
      report PASS "MTU '$n' fits the mesh" "$m ≤ $max"
    fi
  done
else
  report SKIP "MTU vs mesh" "no wt0/tailscale0/wg0 on this host"
fi

# ════════════════════════════════════════════════════════════════════════════
trap on_exit EXIT
say "Functional checks ($CROSS; image $IMAGE)"
cleanup # leftovers from an aborted run
docker pull -q "$IMAGE" >/dev/null 2>&1 || true

A_NET="${PREFIX}-a_default"; B_NET="${PREFIX}-b_default"
LINK_NET="${PREFIX}-link"; DB_NET="${PREFIX}-a_db-net"
A_WEB="${PREFIX}-a_web"; A_CLIENT="${PREFIX}-a_client"
B_API="${PREFIX}-b_api"; B_CLIENT="${PREFIX}-b_client"; DB="${PREFIX}-a_db-primary"; INTRUDER="${PREFIX}-intruder"

for n in "$A_NET" "$B_NET" "$LINK_NET" "$DB_NET"; do mk_net "$n"; done
for n in "$A_NET" "$B_NET" "$LINK_NET" "$DB_NET"; do
  report INFO "MTU '$n'" "$(net_mtu "$n" || true)"
done

mk_server "$A_WEB" "$SERVER_CONSTRAINT" 8080 "name=$A_NET,alias=web"
mk_client "$A_CLIENT" "name=$A_NET,alias=client"
mk_server "$B_API" "$SERVER_CONSTRAINT" 8080 "name=$B_NET,alias=api"
# Checks exec into LOCAL containers only (servers may sit on another node), so
# app B gets its own local client for the "B can't see A's resources" checks.
mk_client "$B_CLIENT" "name=$B_NET,alias=client"
mk_server "$DB" "$SERVER_CONSTRAINT" 5432 "name=$DB_NET"
if [ -n "$EDGE_ID" ]; then mk_client "$INTRUDER" "$EDGE_NET"; fi

ready=1
for s in "$A_WEB" "$A_CLIENT" "$B_API" "$B_CLIENT" "$DB"; do wait_running "$s" || ready=0; done
if [ "$ready" = 0 ]; then
  report FAIL "test services converge" "see messages above (image pull / placement)"
  exit 1
fi
report PASS "test services converge" "servers on ${REMOTE:-$SELF}, clients on $SELF"

# 1 ── within one app ──────────────────────────────────────────────────────
say "1. Within one app (short names)"
sleep 3 # let DNS entries propagate over gossip
if resolves "$A_CLIENT" web; then report PASS "A: resolve 'web'" ""; else report FAIL "A: resolve 'web'" "short-name alias missing"; fi
if resolves "$A_CLIENT" tasks.web; then report PASS "A: resolve 'tasks.web'" "per-task records"; else report FAIL "A: resolve 'tasks.web'" ""; fi
if resolves "$A_CLIENT" "$A_WEB"; then report PASS "A: resolve '$A_WEB'" "full service name"; else report FAIL "A: resolve '$A_WEB'" ""; fi
if http_ok "$A_CLIENT" "http://web:8080/"; then report PASS "A: HTTP web:8080" "$CROSS"; else report FAIL "A: HTTP web:8080" "$CROSS"; fi
size="$(cexec "$A_CLIENT" "wget -q -T 20 -O /tmp/big http://web:8080/big && wc -c < /tmp/big" 2>/dev/null | tr -d ' ' || true)"
if [ "$size" = "2097152" ]; then
  report PASS "A: 2 MB transfer (MTU)" "$CROSS, $size bytes"
else
  report FAIL "A: 2 MB transfer (MTU)" "got '${size:-nothing}' of 2097152 bytes — large packets are being dropped (overlay MTU vs mesh?)"
fi
web_ip="$(cexec "$A_CLIENT" "$(lookup_cmd tasks.web) | head -n1" 2>/dev/null || true)"
if [ -n "$web_ip" ] && cexec "$A_CLIENT" "ping -c1 -W2 -s 1400 $web_ip >/dev/null 2>&1" >/dev/null 2>&1; then
  report PASS "A: ping -s 1400 to web task" "$web_ip"
elif [ -n "$web_ip" ]; then
  report WARN "A: ping -s 1400 to web task" "no reply from $web_ip (ICMP may be filtered; the 2 MB transfer is authoritative)"
else
  report SKIP "A: ping -s 1400 to web task" "no task IP"
fi

# 2 ── between apps ────────────────────────────────────────────────────────
say "2. Between apps (isolated by default)"
if resolves "$A_CLIENT" api; then report FAIL "A cannot resolve B's 'api'" "resolved — apps are not isolated"; else report PASS "A cannot resolve B's 'api'" ""; fi
if resolves "$A_CLIENT" "$B_API"; then report FAIL "A cannot resolve '$B_API'" "resolved"; else report PASS "A cannot resolve '$B_API'" ""; fi

# 4 ── managed resource (before the link, so B's api is still unattached) ─
say "4. Managed resource (private per-resource overlay)"
docker service update -d -q --network-add "$DB_NET" "$A_CLIENT" >/dev/null
wait_running "$A_CLIENT" || true
sleep 3
if resolves "$A_CLIENT" "$DB"; then report PASS "A: resolve '$DB'" ""; else report FAIL "A: resolve '$DB'" ""; fi
if http_ok "$A_CLIENT" "http://$DB:5432/"; then report PASS "A: connect $DB:5432" ""; else report FAIL "A: connect $DB:5432" ""; fi
if ! container_of "$B_CLIENT" >/dev/null; then report FAIL "B (unattached) cannot resolve '$DB'" "no local B client to test from"
elif resolves "$B_CLIENT" "$DB"; then report FAIL "B (unattached) cannot resolve '$DB'" "resolved"; else report PASS "B (unattached) cannot resolve '$DB'" ""; fi

# 3 ── connected apps ──────────────────────────────────────────────────────
say "3. Connected apps (pairing overlay)"
docker service update -d -q --network-add "name=$LINK_NET,alias=api.${PREFIX}-b" "$B_API" >/dev/null
docker service update -d -q --network-add "$LINK_NET" "$A_CLIENT" >/dev/null
wait_running "$B_API" || true
wait_running "$A_CLIENT" || true
sleep 3
if http_ok "$A_CLIENT" "http://api.${PREFIX}-b:8080/"; then report PASS "A → api.${PREFIX}-b:8080" "pair alias"; else report FAIL "A → api.${PREFIX}-b:8080" ""; fi
if http_ok "$A_CLIENT" "http://$B_API:8080/"; then report PASS "A → $B_API:8080" "full name"; else report FAIL "A → $B_API:8080" ""; fi
if resolves "$A_CLIENT" api; then report WARN "A still can't use B's bare 'api'" "bare alias leaked onto the link"; else report PASS "A still can't use B's bare 'api'" "only qualified names cross apps"; fi
if http_ok "$A_CLIENT" "http://web:8080/"; then report PASS "A: 'web' still resolves after link" ""; else report FAIL "A: 'web' still resolves after link" ""; fi

# 5/6 ── security: user service on the shared edge overlay ────────────────
say "5. Security: a routed-app-like service on '$EDGE_NET'"
if [ -z "$EDGE_ID" ]; then
  report SKIP "intruder checks" "no '$EDGE_NET' overlay"
elif ! wait_running "$INTRUDER"; then
  report FAIL "intruder converges" ""
else
  sleep 2
  for name in postgres swarmy_postgres controller swarmy_controller swarmy-clickhouse; do
    if resolves "$INTRUDER" "$name"; then
      report FAIL "intruder cannot resolve '$name'" "resolved from '$EDGE_NET' — control plane exposed"
    else
      report PASS "intruder cannot resolve '$name'" ""
    fi
  done
  if tcp_ok "$INTRUDER" postgres 5432; then report FAIL "intruder cannot connect postgres:5432" "connected"; else report PASS "intruder cannot connect postgres:5432" ""; fi
  if tcp_ok "$INTRUDER" swarmy_postgres 5432; then report FAIL "intruder cannot connect swarmy_postgres:5432" "connected"; else report PASS "intruder cannot connect swarmy_postgres:5432" ""; fi
  if tcp_ok "$INTRUDER" swarmy_controller 3021; then report FAIL "intruder cannot connect swarmy_controller:3021" "connected"; else report PASS "intruder cannot connect swarmy_controller:3021" ""; fi
  if tcp_ok "$INTRUDER" swarmy-clickhouse 8123; then report FAIL "intruder cannot connect swarmy-clickhouse:8123" "connected"; else report PASS "intruder cannot connect swarmy-clickhouse:8123" ""; fi
  report INFO "'$CONTROL_NET' attach by root" "docker itself would let a manager attach a service to '$CONTROL_NET'; swarmy's deploy admission is what refuses user specs naming it (not created here)"
  say "6. Edge reachability (informational)"
  if docker service inspect swarmy-ingress-caddy >/dev/null 2>&1; then
    if resolves "$INTRUDER" swarmy-ingress-caddy; then report PASS "intruder resolves swarmy-ingress-caddy" "edge shares '$EDGE_NET'"; else report WARN "intruder resolves swarmy-ingress-caddy" "edge not on '$EDGE_NET'?"; fi
  else
    report SKIP "intruder resolves swarmy-ingress-caddy" "no edge service"
  fi
fi

# ── summary ─────────────────────────────────────────────────────────────────
say "Summary"
printf 'PASS %d  FAIL %d  WARN %d  SKIP %d\n' "$PASS" "$FAIL" "$WARN" "$SKIP"
[ "$FAIL" -eq 0 ]
