#!/usr/bin/env bash
#
# e2e-smoke.sh — the headline self-host e2e gate (testing-conventions inv. 6):
# a real install → node ONLINE → deploy → reachable over ingress, plus the
# regressions found in live testing (invite-only signup, registry auth, managed
# data on the host, Postgres persistence, guardrails, controller-restart
# resilience).
#
# Runs against an ALREADY-INSTALLED controller on THIS host (it drives the tRPC
# API over HTTP and inspects Docker locally, so run it on the swarm manager).
# CI installs with scripts/install-swarmy.sh first — see .github/workflows/e2e.yml.
#
#   sudo bash scripts/install-swarmy.sh --non-interactive --admin-email e2e@example.com
#   bash scripts/e2e-smoke.sh
#
# Env overrides (all optional):
#   SWARMY_E2E_URL        controller base URL           (default http://127.0.0.1:3021)
#   SWARMY_E2E_ORIGIN     Origin header for auth         (default: the controller's
#                         CONTROLLER_PUBLIC_URL from `docker service inspect`, else URL)
#   SWARMY_E2E_EMAIL      admin email                    (default e2e@example.com)
#   SWARMY_E2E_PASSWORD   admin password                 (default: ADMIN_PASSWORD from
#                         /var/lib/swarmy/install/state.env, read via sudo if needed)
#   SWARMY_E2E_STACK      stack name to deploy into      (default site)
#   SWARMY_E2E_EDGE_IP    IP the ingress listens on      (default 127.0.0.1)
#   SWARMY_E2E_CHECKS     space-separated subset to run  (default "1 2 3 4 5 6 7 8 9")
#   SWARMY_E2E_CONTROLLER_SERVICE  swarm service name    (default swarmy_controller)
#
# Output: one "PASS <n> <name>" / "FAIL <n> <name>: <why>" line per check and a
# summary. On any failure it dumps `docker service ls`, `docker service ps
# --no-trunc`, and controller/agent logs, then exits 1.
set -euo pipefail

# ── config ──────────────────────────────────────────────────────────────────
URL="${SWARMY_E2E_URL:-http://127.0.0.1:3021}"
URL="${URL%/}"
EMAIL="${SWARMY_E2E_EMAIL:-e2e@example.com}"
PASSWORD="${SWARMY_E2E_PASSWORD:-}"
ORIGIN="${SWARMY_E2E_ORIGIN:-}"
STACK="${SWARMY_E2E_STACK:-site}"
EDGE_IP="${SWARMY_E2E_EDGE_IP:-127.0.0.1}"
CHECKS="${SWARMY_E2E_CHECKS:-1 2 3 4 5 6 7 8 9}"
CONTROLLER_SVC="${SWARMY_E2E_CONTROLLER_SERVICE:-swarmy_controller}"
STATE_FILE="/var/lib/swarmy/install/state.env"

HOST="${STACK}.$(printf '%s' "$EDGE_IP" | tr . -).sslip.io"
RUN_ID="$(date +%s)-$$"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/swarmy-e2e.XXXXXX")"
JAR="$WORK/cookies.txt"
trap 'rm -rf "$WORK"' EXIT

c_green=''; c_red=''; c_dim=''; c_reset=''
if [ -t 1 ]; then c_green=$'\033[32m'; c_red=$'\033[31m'; c_dim=$'\033[2m'; c_reset=$'\033[0m'; fi
log()  { printf '%s\n' "${c_dim}  · $*${c_reset}" >&2; }
die()  { printf '%s\n' "${c_red}✗ $*${c_reset}" >&2; exit 1; }

for bin in curl jq docker; do command -v "$bin" >/dev/null 2>&1 || die "missing dependency: $bin"; done

as_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo -n "$@"; fi; }

# Tiny key/value store so checks (run in subshells) can hand values forward.
put() { printf '%s' "$2" > "$WORK/kv.$1"; }
get() { cat "$WORK/kv.$1" 2>/dev/null || true; }

# ── discovery ───────────────────────────────────────────────────────────────
if [ -z "$PASSWORD" ]; then
  # state.env is written with printf %q, so source it rather than cut it.
  # shellcheck disable=SC2016
  PASSWORD="$(as_root bash -c '. "$1" && printf "%s" "${ADMIN_PASSWORD:-}"' _ "$STATE_FILE" 2>/dev/null || true)"
  [ -n "$PASSWORD" ] || die "no admin password: set SWARMY_E2E_PASSWORD or make $STATE_FILE readable (sudo)."
fi
if [ -z "$ORIGIN" ]; then
  ORIGIN="$(docker service inspect "$CONTROLLER_SVC" \
    --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' 2>/dev/null \
    | sed -n 's/^CONTROLLER_PUBLIC_URL=//p' | head -n1 || true)"
  ORIGIN="${ORIGIN:-$URL}"
fi
ORIGIN="${ORIGIN%/}"

# ── HTTP / tRPC helpers ─────────────────────────────────────────────────────
# http METHOD PATH [BODY] [JAR] → body in $WORK/body, echoes the status code.
http() {
  local method="$1" path="$2" body="${3:-}" jar="${4:-$JAR}"
  local args=(-sS -m 30 -o "$WORK/body" -w '%{http_code}' -X "$method"
    -H "origin: $ORIGIN" -b "$jar" -c "$jar")
  [ -n "$body" ] && args+=(-H 'content-type: application/json' --data "$body")
  curl "${args[@]}" "$URL$path" || printf '000'
}

# trpc_query PROC [INPUT_JSON] → prints .result.data.json; non-zero on error.
trpc_query() {
  local proc="$1" input="${2:-}" qs="" code
  if [ -n "$input" ]; then
    qs="?input=$(jq -rn --argjson v "$input" '{json: $v} | tojson | @uri')"
  fi
  code="$(http GET "/api/trpc/${proc}${qs}")"
  if [ "$code" != 200 ]; then log "$proc → HTTP $code: $(head -c 400 "$WORK/body")"; return 1; fi
  jq -c '.result.data.json' "$WORK/body"
}

# trpc_mutate PROC INPUT_JSON → prints .result.data.json; non-zero on error
# (the raw error body stays in $WORK/body for callers that assert on it).
trpc_mutate() {
  local proc="$1" input="$2" code
  code="$(http POST "/api/trpc/${proc}" "$(jq -cn --argjson v "$input" '{json: $v}')")"
  if [ "$code" != 200 ]; then log "$proc → HTTP $code: $(head -c 400 "$WORK/body")"; return 1; fi
  jq -c '.result.data.json' "$WORK/body"
}

sign_in() {
  local code
  rm -f "$JAR"
  code="$(http POST /api/auth/sign-in/email "$(jq -cn --arg e "$EMAIL" --arg p "$PASSWORD" '{email:$e,password:$p}')")"
  [ "$code" = 200 ] || { log "sign-in → HTTP $code: $(head -c 400 "$WORK/body")"; return 1; }
  grep -q 'swarmy\.' "$JAR" || { log "sign-in set no swarmy.* cookie"; return 1; }
}

# poll TIMEOUT_S INTERVAL_S DESC CMD... — retry CMD until it succeeds.
poll() {
  local timeout="$1" interval="$2" desc="$3"; shift 3
  local deadline=$(( $(date +%s) + timeout ))
  while :; do
    if "$@" >/dev/null 2>&1; then return 0; fi
    if [ "$(date +%s)" -ge "$deadline" ]; then log "timed out after ${timeout}s waiting for: $desc"; return 1; fi
    sleep "$interval"
  done
}

# service_ready NAME — services.list shows NAME with running == desired >= 1.
service_ready() {
  trpc_query services.list | jq -e --arg n "$1" \
    'any(.[]; .name == $n and .replicas.desired >= 1 and .replicas.running == .replicas.desired)' >/dev/null
}
service_id() { trpc_query services.list | jq -r --arg n "$1" 'first(.[] | select(.name == $n) | .id) // empty'; }

# Compose deploys follow `docker stack deploy` naming: compose service SHORT in
# stack STACK is the swarm service `<STACK>_<SHORT>`. Scope every lookup to the
# stack (services.list {stackId}) so a same-named service in another stack can
# never satisfy the check.
stack_services() { trpc_query services.list "$(jq -cn --arg s "$1" '{stackId:$s}')"; }
stack_service_ready() {  # stack_service_ready STACK SHORT
  stack_services "$1" | jq -e --arg n "$1_$2" \
    'any(.[]; .name == $n and .replicas.desired >= 1 and .replicas.running == .replicas.desired)' >/dev/null
}
stack_service_id() {  # stack_service_id STACK SHORT → live id (empty if absent)
  stack_services "$1" | jq -r --arg n "$1_$2" 'first(.[] | select(.name == $n) | .id) // empty'
}

nodes_online() { trpc_query nodes.list | jq -e 'length > 0 and all(.[]; .status == "online")' >/dev/null; }

edge_get() {  # edge_get → HTTP code of the deployed app over HTTPS via the ingress
  curl -sk -m 5 -o "$WORK/edge" -w '%{http_code}' --resolve "${HOST}:443:${EDGE_IP}" "https://${HOST}/" 2>/dev/null || printf '000'
}
edge_ok() { [ "$(edge_get)" = 200 ] && grep -q 'Welcome to nginx' "$WORK/edge"; }

task_container() {  # task_container SERVICE → a running container id for that service on this host
  docker ps -q --filter "label=com.docker.swarm.service.name=$1" | head -n1
}

# ── checks ──────────────────────────────────────────────────────────────────
check_1() {  # node online
  poll 180 5 "every node online" nodes_online
  log "nodes: $(trpc_query nodes.list | jq -c '[.[] | {name: (.name // .hostname), status}]')"
}

check_2() {  # deploy from compose → running 1/1
  local compose=$'services:\n  web:\n    image: nginx:1.27-alpine\n'
  trpc_mutate stacks.deployFromCompose "$(jq -cn --arg n "$STACK" --arg c "$compose" '{name:$n, composeSource:$c}')" >/dev/null
  poll 180 3 "${STACK}_web running 1/1" stack_service_ready "$STACK" web
  # The bare compose key must NOT exist as a swarm service in this stack (the
  # pre-namespacing scheme clobbered same-named services across stacks).
  stack_services "$STACK" | jq -e 'all(.[]; .name != "web")' >/dev/null \
    || { log "stack $STACK still has a bare-named 'web' service"; return 1; }
  local id; id="$(stack_service_id "$STACK" web)"
  [ -n "$id" ] || { log "no id for ${STACK}_web"; return 1; }
  put web_id "$id"
}

ingress_serving() { trpc_query ingress.getConfig | jq -e '.runtime.state == "serving"' >/dev/null; }
check_3() {  # ingress + HTTPS via Caddy local CA
  local id; id="$(get web_id)"
  [ -n "$id" ] || { log "needs check 2 (no web service id)"; return 1; }
  if ! trpc_mutate ingress.addDomain "$(jq -cn --arg h "$HOST" --arg s "$id" \
      '{host:$h, serviceId:$s, targetPort:80, tls:"auto"}')" >/dev/null; then
    # Re-runs against the same install: an existing route for the host is fine.
    grep -qiE 'already|exists|unique' "$WORK/body" || return 1
    log "domain $HOST already present — reusing"
  fi
  poll 180 3 "https://${HOST}/ → 200 + nginx welcome" edge_ok
  poll 60 3 "ingress runtime serving" ingress_serving \
    || { log "runtime: $(trpc_query ingress.getConfig | jq -c '.runtime')"; return 1; }
}

check_4() {  # invite-only signup
  local code rand tjar="$WORK/anon.txt" mjar="$WORK/member.txt"
  rand="e2e-stranger-${RUN_ID}@example.com"
  code="$(http POST /api/auth/sign-up/email \
    "$(jq -cn --arg e "$rand" '{email:$e, password:"Str4nger-passw0rd!", name:"Stranger"}')" "$tjar")"
  [ "$code" = 403 ] || { log "stranger sign-up → $code (want 403): $(head -c 300 "$WORK/body")"; return 1; }
  grep -q 'SIGNUP_INVITE_ONLY' "$WORK/body" || { log "403 without SIGNUP_INVITE_ONLY: $(head -c 300 "$WORK/body")"; return 1; }
  trpc_query authConfig.publicConfig | jq -e '.signupMode == "invite-only"' >/dev/null

  local tm="tm-${RUN_ID}@example.com" link
  link="$(trpc_mutate members.invite "$(jq -cn --arg e "$tm" '{email:$e, role:"member"}')" | jq -r '.link // empty')"
  [ -n "$link" ] || { log "members.invite returned no link"; return 1; }
  code="$(http POST /api/auth/sign-up/email \
    "$(jq -cn --arg e "$tm" '{email:$e, password:"Teammate-passw0rd!", name:"Teammate"}')" "$mjar")"
  [ "$code" = 200 ] || { log "invited sign-up → $code: $(head -c 300 "$WORK/body")"; return 1; }
}

registry_enforced() { trpc_query cicd.getRegistryConfig | jq -e '.authEnforced == true' >/dev/null; }
registry_401() { [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:5000/v2/)" = 401 ]; }
check_5() {  # in-swarm registry requires auth
  trpc_mutate cicd.setRegistryEnabled '{"enabled":true}' >/dev/null
  poll 180 5 "registry authEnforced" registry_enforced
  poll 60 3 "registry :5000/v2/ → 401" registry_401 \
    || { log "registry :5000/v2/ → $(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:5000/v2/ || true)"; return 1; }
}

check_6() {  # managed cache + host-side restic backup/restore
  local out tid snap prefix="e2e-${RUN_ID}" repo="/srv/swarmy-e2e"
  trpc_mutate cache.provision "$(jq -cn --arg s "$STACK" '{stack:$s, name:"main"}')" >/dev/null \
    || grep -qiE 'already|exists' "$WORK/body" || return 1
  poll 240 5 "${STACK}_main-cache running 1/1" service_ready "${STACK}_main-cache"

  out="$(trpc_mutate backups.addTarget "$(jq -cn --arg p "$prefix" --arg b "$repo" \
    '{name:("disk-" + $p), kind:"node", bucket:$b, prefix:$p}')")"
  tid="$(jq -r '.id // empty' <<<"$out")"
  [ -n "$tid" ] || { log "addTarget returned no id: $out"; return 1; }

  out="$(trpc_mutate backups.backupVolume "$(jq -cn --arg t "$tid" --arg v "${STACK}_main-cache-data" \
    '{targetId:$t, volume:$v}')")"
  snap="$(jq -r '.snapshotId // empty' <<<"$out")"
  [ -n "$snap" ] || { log "backupVolume returned no snapshotId: $out"; return 1; }
  log "snapshot $snap ($(jq -r '.sizeBytes' <<<"$out") bytes)"

  # The restic repo must land on the HOST filesystem, not inside a container.
  as_root test -e "$repo/$prefix/config" || { log "no restic repo at $repo/$prefix/config on the host"; return 1; }

  out="$(trpc_mutate backups.restoreSnapshot "$(jq -cn --arg s "$snap" --arg v "e2e-restore-${RUN_ID}" \
    '{snapshotId:$s, targetVolume:$v}')")"
  jq -e '(.bytesRestored | tonumber) > 0' <<<"$out" >/dev/null || { log "restore: $out"; return 1; }
}

pg_sql() {  # pg_sql SQL → runs in the primary's container against db `app`
  local cid; cid="$(task_container "${STACK}_pg-primary")"
  [ -n "$cid" ] || return 1
  docker exec -e PGPASSWORD="$(get pg_pw)" "$cid" \
    psql -h 127.0.0.1 -U postgres -d app -v ON_ERROR_STOP=1 -tAc "$1"
}
pg_has_row() { [ "$(pg_sql "SELECT v FROM e2e_persist WHERE v = '$(get pg_marker)'")" = "$(get pg_marker)" ]; }
check_7() {  # managed Postgres data survives a task reschedule
  local svc="${STACK}_pg-primary" out pw marker="row-${RUN_ID}"
  out="$(trpc_mutate db.provision "$(jq -cn --arg s "$STACK" '{stack:$s, name:"pg", replicas:0}')")"
  pw="$(jq -r '.password // empty' <<<"$out")"
  [ -n "$pw" ] || { log "db.provision returned no password"; return 1; }
  put pg_pw "$pw"; put pg_marker "$marker"
  poll 300 5 "$svc running 1/1" service_ready "$svc"

  docker service inspect "$svc" --format '{{json .Spec.TaskTemplate.ContainerSpec.Mounts}}' \
    | jq -e 'any(.[]?; .Target == "/var/lib/postgresql/data" and .Type == "volume")' >/dev/null \
    || { log "$svc has no volume mount at /var/lib/postgresql/data"; return 1; }

  poll 120 3 "postgres accepting connections" pg_sql 'SELECT 1'
  pg_sql "CREATE TABLE IF NOT EXISTS e2e_persist (v text PRIMARY KEY); INSERT INTO e2e_persist VALUES ('$marker')" >/dev/null

  log "forcing a reschedule of $svc"
  timeout 300 docker service update --force --detach=false --quiet "$svc" >/dev/null
  poll 240 5 "$svc back to 1/1" service_ready "$svc"
  poll 180 3 "row $marker readable after reschedule" pg_has_row
}

check_8() {  # production guardrails block :latest
  local rc=0
  trpc_mutate guardrails.setSafetyMode '{"enabled":true}' >/dev/null
  trpc_mutate guardrails.setStackEnv "$(jq -cn --arg s "$STACK" '{stack:$s, production:true}')" >/dev/null
  if trpc_mutate services.create "$(jq -cn --arg s "$STACK" '{name:"bad", image:"nginx:latest", project:$s}')" >/dev/null 2>&1; then
    log "services.create with nginx:latest in prod was ADMITTED"; rc=1
    trpc_mutate services.remove "$(jq -cn --arg s "${STACK}_bad" '{id:$s}')" >/dev/null 2>&1 || true
  elif ! grep -q 'no-latest-tag-in-prod' "$WORK/body"; then
    log "rejected, but not by no-latest-tag-in-prod: $(head -c 400 "$WORK/body")"; rc=1
  fi
  # Disarm so later checks / re-runs aren't blocked.
  trpc_mutate guardrails.setStackEnv "$(jq -cn --arg s "$STACK" '{stack:$s, production:false}')" >/dev/null || rc=1
  trpc_mutate guardrails.setSafetyMode '{"enabled":false}' >/dev/null || rc=1
  return "$rc"
}

controller_healthy() { curl -fsS -m 3 "$URL/health" >/dev/null; }
check_9() {  # data plane survives a controller crash
  local cid samples="$WORK/samples" ok total
  poll 60 2 "app reachable before kill" edge_ok || { log "needs check 3 (app not reachable over ingress)"; return 1; }
  cid="$(task_container "$CONTROLLER_SVC")"
  [ -n "$cid" ] || { log "no running $CONTROLLER_SVC container on this host"; return 1; }

  : > "$samples"
  (
    for _ in $(seq 1 30); do
      curl -sk -m 2 -o /dev/null -w '%{http_code}\n' --resolve "${HOST}:443:${EDGE_IP}" "https://${HOST}/" >> "$samples" 2>/dev/null \
        || printf '000\n' >> "$samples"
      sleep 2
    done
  ) &
  local sampler=$!
  sleep 2
  log "killing controller container ${cid:0:12}"
  docker kill "$cid" >/dev/null
  wait "$sampler"

  total="$(wc -l < "$samples" | tr -d ' ')"
  ok="$(grep -c '^200$' "$samples" || true)"
  log "app availability during controller outage: $ok/$total"
  if [ "$total" -lt 30 ] || [ "$ok" != "$total" ]; then
    log "non-200 samples: $(grep -v '^200$' "$samples" | sort | uniq -c | tr '\n' ' ')"; return 1
  fi

  poll 240 3 "controller healthy again" controller_healthy
  poll 60 3 "re-sign-in after restart" sign_in
  poll 180 5 "nodes online after controller restart" nodes_online
}

# ── runner ──────────────────────────────────────────────────────────────────
check_name() {
  case "$1" in
    1) echo "node online" ;;            2) echo "deploy from compose" ;;
    3) echo "ingress + HTTPS" ;;        4) echo "invite-only signup" ;;
    5) echo "registry auth" ;;          6) echo "managed cache backup/restore" ;;
    7) echo "postgres persistence" ;;   8) echo "guardrails" ;;
    9) echo "controller restart resilience" ;;
    *) return 1 ;;
  esac
}
# Later checks need the node + the deployed app; if either fails, stop.
REQUIRED="1 2"

dump_diagnostics() {
  printf '\n===== diagnostics =====\n'
  printf '\n--- docker service ls ---\n'; docker service ls 2>&1 || true
  printf '\n--- docker service ps --no-trunc ---\n'
  # shellcheck disable=SC2046
  docker service ps --no-trunc $(docker service ls -q 2>/dev/null) 2>&1 || true
  printf '\n--- controller logs (%s) ---\n' "$CONTROLLER_SVC"
  docker service logs --no-trunc --tail 400 "$CONTROLLER_SVC" 2>&1 || true
  printf '\n--- agent logs (swarmy-agent) ---\n'
  docker logs --tail 200 swarmy-agent 2>&1 || true
}

printf 'swarmy e2e smoke → %s (origin %s, stack %s, host %s)\n' "$URL" "$ORIGIN" "$STACK" "$HOST"
poll 120 2 "controller /health" controller_healthy || die "controller at $URL is not healthy."
sign_in || die "could not sign in as $EMAIL at $URL (origin $ORIGIN)."

passed=0; failed=0; failed_list=""
for n in $CHECKS; do
  name="$(check_name "$n")" || die "unknown check: $n (valid: 1-9)"
  start="$(date +%s)"
  printf '%s\n' "${c_dim}── $n $name${c_reset}"
  # Subshell + explicit `set -e` so any failing command fails just this check
  # (a function called from `if`/`||` would silently ignore errexit).
  set +e
  ( set -e; "check_$n" ) 2>&1 | tee "$WORK/err.$n"
  rc="${PIPESTATUS[0]}"
  set -e
  dur=$(( $(date +%s) - start ))
  if [ "$rc" -eq 0 ]; then
    printf '%s\n' "${c_green}PASS${c_reset} $n $name (${dur}s)"
    passed=$((passed + 1))
  else
    why="$(grep -v '^$' "$WORK/err.$n" 2>/dev/null | tail -n1 | sed 's/^ *· //')"
    printf '%s\n' "${c_red}FAIL${c_reset} $n $name (${dur}s): ${why:-exit $rc}"
    failed=$((failed + 1)); failed_list="$failed_list $n"
    case " $REQUIRED " in *" $n "*) printf 'check %s is a prerequisite — stopping.\n' "$n"; break ;; esac
  fi
done

printf '\n%d passed, %d failed%s\n' "$passed" "$failed" "${failed_list:+ (failed:$failed_list)}"
if [ "$failed" -gt 0 ]; then dump_diagnostics; exit 1; fi
