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
 * `SWARMY_REGISTRY_MIRROR_FALLBACK` (default mirror.gcr.io) is listed second.
 */
export const DEFAULT_REGISTRY_MIRROR_URL = 'http://localhost:5001';
/**
 * Second mirror, after the cache: Google's public Docker Hub mirror (no
 * per-IP anonymous cap). When the cache errors, a 500 while Hub rate-limits it,
 * dockerd tries the next mirror before Hub itself, so a deploy survives
 * the cache failing. `SWARMY_REGISTRY_MIRROR_FALLBACK` overrides; empty or
 * `off` disables it.
 */
export const DEFAULT_REGISTRY_MIRROR_FALLBACK_URL = 'https://mirror.gcr.io';

export const DOCKER_REGISTRY_MIRROR_SH = `# >>> swarmy docker-registry-mirror (keep in sync: apps/api/src/install/docker-registry-mirror.ts)
SWARMY_REGISTRY_MIRROR="\${SWARMY_REGISTRY_MIRROR-${DEFAULT_REGISTRY_MIRROR_URL}}"
SWARMY_REGISTRY_MIRROR_FALLBACK="\${SWARMY_REGISTRY_MIRROR_FALLBACK-${DEFAULT_REGISTRY_MIRROR_FALLBACK_URL}}"
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
      printf '{"registry-mirrors": ["%s", "%s"]}\\n' "$SWARMY_REGISTRY_MIRROR" "$SWARMY_REGISTRY_MIRROR_FALLBACK"
    else
      printf '{"registry-mirrors": ["%s"]}\\n' "$SWARMY_REGISTRY_MIRROR"
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
      jq -e --arg m "$SWARMY_REGISTRY_MIRROR" --arg f "$SWARMY_REGISTRY_MIRROR_FALLBACK" \\
        '.["registry-mirrors"] == [$m] and $f != ""' "$mrm_file" >/dev/null 2>&1 || return 3
    fi
    jq --arg m "$SWARMY_REGISTRY_MIRROR" --arg f "$SWARMY_REGISTRY_MIRROR_FALLBACK" \\
      '. + {"registry-mirrors": ([$m, $f] | map(select(. != "")))}' \\
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
      ok "Docker Hub pulls go through the swarm's pull-through cache ($SWARMY_REGISTRY_MIRROR\${SWARMY_REGISTRY_MIRROR_FALLBACK:+, then $SWARMY_REGISTRY_MIRROR_FALLBACK})."
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
