/**
 * Daemon-level Docker log rotation + journald cap, shared by BOTH installers:
 * the controller installer (`scripts/install-swarmy.sh`, between the
 * `>>> swarmy docker-log-opts` markers — a test pins the two copies equal)
 * and the worker join script rendered by `./installer.ts`.
 *
 * Why daemon-level when every swarmy service already carries a bounded
 * `LogDriver` (core `DEFAULT_LOG_DRIVER`)? It also caps containers swarmy
 * does not deploy as services — the agent container itself, the mesh
 * sidecar, one-shot build/backup helpers, and anything the operator runs by
 * hand — so a node's disk can't fill with logs from any source.
 *
 * Safety rules (POSIX sh, no bashisms — the join script runs under `sh`):
 *  - never touch a daemon.json that already sets `log-driver` or `log-opts`
 *    (the operator chose; respect it);
 *  - merge into an existing daemon.json with python3 or jq; if neither is
 *    available, leave it alone and warn (never hand-edit JSON with sed);
 *  - validate with `dockerd --validate` when the engine supports it, keep a
 *    `.swarmy-bak` backup, and restore it on a failed validation;
 *  - only restart dockerd when NO container is running (a fresh box); a busy
 *    node gets the file + a warning that it applies on the next restart —
 *    swarmy services are already bounded by their own LogDriver.
 */
export const DOCKER_LOG_OPTS_SH = `# >>> swarmy docker-log-opts (keep in sync: apps/api/src/install/docker-log-opts.ts)
SWARMY_LOG_MAX_SIZE="\${SWARMY_LOG_MAX_SIZE:-10m}"
SWARMY_LOG_MAX_FILE="\${SWARMY_LOG_MAX_FILE:-3}"
SWARMY_JOURNALD_MAX="\${SWARMY_JOURNALD_MAX:-500M}"

# merge_log_opts FILE → prints the merged daemon.json on stdout.
# exit 0 = changed (stdout is the new file) · 3 = already configured, leave it
# · 2 = cannot merge safely (no python3/jq, or unparseable JSON).
merge_log_opts() {
  mlo_file="$1"
  mlo_default="{\\"log-driver\\": \\"json-file\\", \\"log-opts\\": {\\"max-size\\": \\"$SWARMY_LOG_MAX_SIZE\\", \\"max-file\\": \\"$SWARMY_LOG_MAX_FILE\\"}}"
  if [ ! -s "$mlo_file" ] || ! grep -q '[^[:space:]]' "$mlo_file"; then
    printf '%s\\n' "$mlo_default"
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
    jq --arg s "$SWARMY_LOG_MAX_SIZE" --arg n "$SWARMY_LOG_MAX_FILE" \\
      'if type == "object" then . + {"log-driver": "json-file", "log-opts": {"max-size": $s, "max-file": $n}} else error("not an object") end' \\
      "$mlo_file" 2>/dev/null || return 2
    return 0
  fi
  return 2
}

# ensure_docker_log_opts — apply merge_log_opts to /etc/docker/daemon.json safely.
ensure_docker_log_opts() {
  edlo_file="\${SWARMY_DAEMON_JSON:-/etc/docker/daemon.json}"
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
  if [ -d /etc/systemd ] && command -v systemctl >/dev/null 2>&1 && [ ! -e /etc/systemd/journald.conf.d/swarmy.conf ] \\
    && ! grep -qs '^SystemMaxUse=' /etc/systemd/journald.conf; then
    mkdir -p /etc/systemd/journald.conf.d
    printf '[Journal]\\nSystemMaxUse=%s\\n' "$SWARMY_JOURNALD_MAX" > /etc/systemd/journald.conf.d/swarmy.conf
    systemctl restart systemd-journald >/dev/null 2>&1 || true
  fi
  return 0
}
# <<< swarmy docker-log-opts
`;

/** `docker run` flags that bound a container swarmy starts outside a service. */
export const DOCKER_RUN_LOG_FLAGS = '--log-driver json-file --log-opt max-size=10m --log-opt max-file=3';
