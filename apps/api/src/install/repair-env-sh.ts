/**
 * The node installer's env-file handling (POSIX sh, embedded by ./installer.ts):
 * what a REPAIR run keeps from `/etc/swarmy/agent.env`, and how the file is
 * written. A separate snippet so a test can run it against a real file
 * (repair-env-sh.test.ts) instead of grepping the rendered script.
 *
 * The rule a repair keeps: re-running the one-liner on an enrolled box never
 * LOSES configuration, and never mixes two meshes. Every value the one-liner
 * leaves unset comes back from the existing file, except the mesh settings,
 * which move as ONE unit:
 *  - the one-liner brings a fresh setup key → its own management URL, driver
 *    and CA go with it (a fresh NetBird Cloud key paired with an old
 *    self-hosted URL from the file can't join anything);
 *  - the one-liner brings no key → the node's whole saved mesh config stays.
 *
 * Callers set JOIN_TOKEN, NODE_LABELS, ALLOW_BUILD, ALLOW_MESH, MESH_SETUP_KEY,
 * MESH_MANAGEMENT_URL, MESH_DRIVER, MESH_CA_B64 (empty = not given) and, for
 * write_env, ENV_FILE, WS_URL and STATE_DIR. ALLOW_MESH / MESH_DRIVER get their
 * defaults AFTER the salvage, so a node that opted out of the mesh stays out.
 */
export const REPAIR_ENV_SH = `# >>> swarmy repair-env (apps/api/src/install/repair-env-sh.ts)
# env_value FILE KEY: the value of the first KEY= line in FILE, or nothing.
env_value() { sed -n "s/^$2=//p" "$1" 2>/dev/null | head -1; }

# salvage_install_env FILE: fill what the one-liner left unset from FILE.
# The mesh settings are one unit: kept together, or replaced together.
salvage_install_env() {
  [ -f "$1" ] || return 0
  [ -n "$JOIN_TOKEN" ]  || JOIN_TOKEN="$(env_value "$1" SWARMY_JOIN_TOKEN)"
  [ -n "$NODE_LABELS" ] || NODE_LABELS="$(env_value "$1" SWARMY_NODE_LABELS)"
  [ -n "$ALLOW_BUILD" ] || ALLOW_BUILD="$(env_value "$1" SWARMY_ALLOW_BUILD)"
  [ -n "$ALLOW_MESH" ]  || ALLOW_MESH="$(env_value "$1" SWARMY_ALLOW_MESH)"
  if [ -z "$MESH_SETUP_KEY" ]; then
    MESH_SETUP_KEY="$(env_value "$1" SWARMY_MESH_SETUP_KEY)"
    [ -n "$MESH_MANAGEMENT_URL" ] || MESH_MANAGEMENT_URL="$(env_value "$1" SWARMY_MESH_MANAGEMENT_URL)"
    [ -n "$MESH_DRIVER" ]         || MESH_DRIVER="$(env_value "$1" SWARMY_MESH_DRIVER)"
    [ -n "$MESH_CA_B64" ]         || MESH_CA_B64="$(env_value "$1" SWARMY_MESH_CA_B64)"
  fi
}

write_env() {
  mkdir -p "$(dirname "$ENV_FILE")"
  umask 077
  {
    echo "AGENT_WS_URL=$WS_URL"
    echo "SWARMY_AGENT_STATE=$STATE_DIR/agent.json"
    echo "SWARMY_JOIN_TOKEN=$JOIN_TOKEN"
    echo "SWARMY_ALLOW_MESH=$ALLOW_MESH"
    [ -z "$ALLOW_BUILD" ] || echo "SWARMY_ALLOW_BUILD=$ALLOW_BUILD"
    [ -z "$NODE_LABELS" ] || echo "SWARMY_NODE_LABELS=$NODE_LABELS"
    [ -z "$MESH_SETUP_KEY" ] || echo "SWARMY_MESH_SETUP_KEY=$MESH_SETUP_KEY"
    [ -z "$MESH_MANAGEMENT_URL" ] || echo "SWARMY_MESH_MANAGEMENT_URL=$MESH_MANAGEMENT_URL"
    echo "SWARMY_MESH_DRIVER=$MESH_DRIVER"
    [ -z "$MESH_CA_B64" ] || echo "SWARMY_MESH_CA_B64=$MESH_CA_B64"
  } > "$ENV_FILE"
  # A repair rewrites an existing file, which keeps its old mode: force 0600.
  chmod 600 "$ENV_FILE"
}
# <<< swarmy repair-env
`;
