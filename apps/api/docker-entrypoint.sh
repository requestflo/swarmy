#!/bin/sh
# swarmy controller entrypoint.
#
# 1. Expand Docker-secret files: for any VAR_FILE pointing at a readable file
#    (secrets are mounted under /run/secrets), load its contents into VAR. This
#    keeps SWARMY_SECRET_KEY / BETTER_AUTH_SECRET / passwords out of the image,
#    the service spec, and `docker inspect` env.
# 2. exec the CMD (the controller, or a bootstrap one-shot when overridden).
set -eu

# file_env VAR — if ${VAR}_FILE is set and readable, export VAR from its contents.
file_env() {
  var="$1"
  eval file="\${${var}_FILE:-}"
  if [ -n "${file:-}" ] && [ -f "$file" ]; then
    val="$(cat "$file")"
    export "$var=$val"
  fi
}

file_env SWARMY_SECRET_KEY
file_env BETTER_AUTH_SECRET
file_env ADMIN_PASSWORD
file_env CLOUDFLARE_API_TOKEN
# Self-host bootstrap material (read by apps/api/src/bootstrap/seed.ts).
file_env SWARMY_BOOTSTRAP_JOIN_TOKEN
file_env SWARM_WORKER_TOKEN
file_env SWARM_MANAGER_TOKEN
file_env SWARMY_MESH_SERVICE_TOKEN

exec "$@"
