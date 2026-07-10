#!/bin/sh
# swarmy controller entrypoint.
#
# 1. Expand Docker-secret files: for any VAR_FILE pointing at a readable file
#    (secrets are mounted under /run/secrets), load its contents into VAR. This
#    keeps SWARMY_SECRET_KEY / BETTER_AUTH_SECRET / passwords out of the image,
#    the service spec, and `docker inspect` env.
# 2. Standard tier: compose DATABASE_URL from POSTGRES_* when not supplied.
# 3. exec the CMD (the controller, or a bootstrap one-shot when overridden).
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
file_env POSTGRES_PASSWORD
file_env ADMIN_PASSWORD
file_env CLOUDFLARE_API_TOKEN
# Self-host bootstrap material (read by apps/api/src/bootstrap/seed.ts).
file_env SWARMY_BOOTSTRAP_JOIN_TOKEN
file_env SWARM_WORKER_TOKEN
file_env SWARM_MANAGER_TOKEN
file_env SWARMY_MESH_SERVICE_TOKEN

# Standard tier (managed Postgres service): build DATABASE_URL if absent.
if [ "${SWARMY_DB_DRIVER:-postgres}" = "postgres" ] && [ -z "${DATABASE_URL:-}" ] && [ -n "${POSTGRES_PASSWORD:-}" ]; then
  : "${POSTGRES_USER:=swarmy}"
  : "${POSTGRES_DB:=swarmy}"
  : "${POSTGRES_HOST:=postgres}"
  : "${POSTGRES_PORT:=5432}"
  export DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}"
fi

exec "$@"
