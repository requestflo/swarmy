/**
 * The legacy `GET /install.sh`'s env-file plumbing (POSIX sh, embedded by
 * ./legacy-install-sh.ts after ./repair-env-sh.ts, whose `salvage_install_env`
 * and `write_env` it shares with the node installer).
 *
 * The env file (`/etc/swarmy/agent.env`, root-only, 0600) is how secrets reach
 * the agent container: bind-mounted read-only, loaded by the agent itself
 * (apps/agent/src/env.ts). It is kept across re-runs and shredded by
 * `--uninstall`, as the node installer does.
 *
 * Callers set ENV_FILE, CONTAINER_NAME, STATE_VOLUME (DOCKER_MISSING when
 * there is no docker) and define `say`, `ok` and `die`.
 */
export const LEGACY_ENV_SH = `# >>> swarmy legacy-env (apps/api/src/install/legacy-env-sh.ts)
# need_env_dir: the env file keeps secrets off the docker command line; writing it needs root.
need_env_dir() {
  mkdir -p "$(dirname "$ENV_FILE")" 2>/dev/null && [ -w "$(dirname "$ENV_FILE")" ] && return 0
  die "Cannot write $ENV_FILE (it keeps the join token off the docker command line). Run as root: … | sudo SWARMY_JOIN_TOKEN=<token> sh"
}

# seed_env_from_container NAME: an install from before the env file kept its
# settings in the container's env; copy the agent's keys into ENV_FILE (0600)
# so salvage_install_env can keep them.
seed_env_from_container() {
  ( umask 077
    docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null \\
      | grep -E '^(AGENT_WS_URL|SWARMY_[A-Z0-9_]+)=' > "$ENV_FILE" ) || true
  chmod 600 "$ENV_FILE" 2>/dev/null || true
}

# uninstall_agent: the container, its state volume (the saved session) and the
# env file. The file holds the join token and mesh key: shred it when possible.
uninstall_agent() {
  [ -z "\${DOCKER_MISSING:-}" ] || [ -f "$ENV_FILE" ] || die "Docker not found — nothing to uninstall."
  say "Removing the swarmy agent…"
  if [ -z "\${DOCKER_MISSING:-}" ]; then
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
    docker volume rm "$STATE_VOLUME" >/dev/null 2>&1 || true
  fi
  if [ -f "$ENV_FILE" ]; then
    { command -v shred >/dev/null 2>&1 && shred -u "$ENV_FILE"; } || rm -f "$ENV_FILE"
  fi
  rmdir "$(dirname "$ENV_FILE")" 2>/dev/null || true
  ok "swarmy agent removed. Docker and any swarm membership were left untouched."
  say "To also leave the swarm:  docker swarm leave --force"
}
# <<< swarmy legacy-env
`;
