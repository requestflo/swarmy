/**
 * dockerd `registry-mirrors` → swarmy's Docker Hub pull-through cache
 * (self-reliance B4), shared by BOTH installers exactly like
 * `./docker-log-opts.ts`: the controller installer (`scripts/install-swarmy.sh`,
 * between the `>>> swarmy docker-registry-mirror` markers — a test pins the two
 * copies equal) and the worker join script rendered by `./installer.ts`.
 *
 * The cache is the `swarmy-registry-cache` swarm service (registry:2 in proxy
 * mode) published on :5001 through the routing mesh, so `localhost:5001` answers
 * on every node and dockerd trusts loopback registries as insecure by default.
 * dockerd only consults `registry-mirrors` for Docker Hub, and falls back to Hub
 * itself when the mirror is down, so writing it before the cache exists is safe.
 * (GHCR / gcr.io system images come from the mirrored copies in the built-in
 * registry instead — `@swarmy/core/system-images`.)
 *
 * Safety rules — the same as the log-opts merge:
 *  - never touch a daemon.json that already sets `registry-mirrors` (the
 *    operator chose; ours already present is a no-op);
 *  - merge with python3 or jq; neither → leave it alone and warn (never sed JSON);
 *  - validate with `dockerd --validate` when supported, keep a `.swarmy-bak`,
 *    and restore it when validation or the restart fails;
 *  - restart dockerd only when NO container is running; a busy node gets the
 *    file + a warning that it applies on the next restart.
 *
 * `SWARMY_REGISTRY_MIRROR` overrides the URL; empty or `off` skips this step.
 */
export const DEFAULT_REGISTRY_MIRROR_URL = 'http://localhost:5001';

export const DOCKER_REGISTRY_MIRROR_SH = `# >>> swarmy docker-registry-mirror (keep in sync: apps/api/src/install/docker-registry-mirror.ts)
SWARMY_REGISTRY_MIRROR="\${SWARMY_REGISTRY_MIRROR-${DEFAULT_REGISTRY_MIRROR_URL}}"

# merge_registry_mirror FILE → prints the merged daemon.json on stdout.
# exit 0 = changed (stdout is the new file) · 3 = already configured, leave it
# · 2 = cannot merge safely (no python3/jq, or unparseable JSON).
merge_registry_mirror() {
  mrm_file="$1"
  if [ ! -s "$mrm_file" ] || ! grep -q '[^[:space:]]' "$mrm_file"; then
    printf '{"registry-mirrors": ["%s"]}\\n' "$SWARMY_REGISTRY_MIRROR"
    return 0
  fi
  if grep -q '"registry-mirrors"' "$mrm_file"; then
    return 3
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$mrm_file" "$SWARMY_REGISTRY_MIRROR" <<'SWARMY_PY_EOF' || return 2
import json, sys
with open(sys.argv[1]) as f:
    cfg = json.load(f)
if not isinstance(cfg, dict):
    sys.exit(2)
cfg["registry-mirrors"] = [sys.argv[2]]
print(json.dumps(cfg, indent=2))
SWARMY_PY_EOF
    return 0
  fi
  if command -v jq >/dev/null 2>&1; then
    jq --arg m "$SWARMY_REGISTRY_MIRROR" \\
      'if type == "object" then . + {"registry-mirrors": [$m]} else error("not an object") end' \\
      "$mrm_file" 2>/dev/null || return 2
    return 0
  fi
  return 2
}

# ensure_docker_registry_mirror — apply merge_registry_mirror to /etc/docker/daemon.json safely.
ensure_docker_registry_mirror() {
  case "$SWARMY_REGISTRY_MIRROR" in ''|off|none) return 0 ;; esac
  edrm_file="\${SWARMY_DAEMON_JSON:-/etc/docker/daemon.json}"
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
      ok "Docker Hub pulls go through the swarm's pull-through cache ($SWARMY_REGISTRY_MIRROR)."
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
`;
