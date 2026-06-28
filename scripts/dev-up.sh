#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
#
# One-command local bring-up of a REAL swarmy controller + a local node.
#
# Ensures Docker is running, makes the host a single-node Docker Swarm (so the
# laptop is a manager and the agent can `docker service` against it), starts
# Postgres, generates + pushes the Prisma schema, and seeds a dev login user +
# org + join token. It then prints the two foreground commands to run rather
# than backgrounding the dev servers + agent unreliably from one script.
#
# Usage: bun run dev:up   (or: bash scripts/dev-up.sh)

set -euo pipefail

cd "$(dirname "$0")/.."

say()  { printf '\033[1;36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── 0. Prerequisites ────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker not found. Install Docker Desktop (mac/win) or Docker Engine (linux)."
command -v bun    >/dev/null 2>&1 || die "bun not found. Install Bun: https://bun.sh"

say "Checking Docker is running…"
if ! docker info >/dev/null 2>&1; then
  die "Docker is not running. Start Docker Desktop / the Docker engine and re-run."
fi
ok "Docker is up."

# ── 1. Ensure .env exists ───────────────────────────────────────────────────
if [[ ! -f .env ]]; then
  warn ".env not found — copying from .env.example."
  cp .env.example .env
  warn "Set a real BETTER_AUTH_SECRET in .env: openssl rand -base64 32"
fi

# ── 2. Single-node swarm (idempotent) ───────────────────────────────────────
# `docker swarm init` errors if the host is already a swarm; swallow that case.
say "Ensuring the host is a Docker Swarm…"
swarm_state="$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || echo 'unknown')"
if [[ "$swarm_state" == "active" ]]; then
  ok "Host is already part of a swarm."
else
  if docker swarm init >/dev/null 2>&1; then
    ok "Initialised a single-node swarm (this laptop is now a manager)."
  else
    # Common with multiple interfaces — retry pinning the advertise address.
    if docker swarm init --advertise-addr 127.0.0.1 >/dev/null 2>&1; then
      ok "Initialised a single-node swarm (advertised on 127.0.0.1)."
    else
      # If it's actually already a swarm, that's fine; otherwise surface it.
      swarm_state="$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || echo 'unknown')"
      [[ "$swarm_state" == "active" ]] || die "docker swarm init failed. Run 'docker swarm init' manually to see the error."
      ok "Host is already part of a swarm."
    fi
  fi
fi

# ── 3. Postgres ─────────────────────────────────────────────────────────────
say "Starting Postgres (docker compose)…"
bun docker:up
ok "Postgres container requested."

say "Waiting for Postgres to become healthy…"
db_port="$(grep -E '^SWARMY_DB_PORT=' .env | head -1 | cut -d= -f2 || true)"
db_port="${db_port:-5678}"
cid="$(docker compose --env-file .env -f docker/docker-compose.yml ps -q postgres || true)"
healthy=0
for _ in $(seq 1 60); do
  if [[ -n "$cid" ]]; then
    status="$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo '')"
    if [[ "$status" == "healthy" ]]; then healthy=1; break; fi
  fi
  # Fallback probe in case the container has no healthcheck wired.
  if docker exec "$cid" pg_isready -U swarmy -d swarmy >/dev/null 2>&1; then healthy=1; break; fi
  sleep 1
done
[[ "$healthy" == "1" ]] || die "Postgres did not become healthy. Check 'bun docker:up' logs. (port $db_port — if taken, set SWARMY_DB_PORT)"
ok "Postgres healthy on host port $db_port."

# ── 4. Schema + Prisma client ───────────────────────────────────────────────
say "Generating Prisma client…"
bun db:generate
ok "Prisma client generated."

say "Pushing schema to the database…"
bun db:push
ok "Schema applied."

# ── 5. Seed ─────────────────────────────────────────────────────────────────
say "Seeding dev user + org + join token…"
bun run seed-dev

# ── 6. Next steps ───────────────────────────────────────────────────────────
cat <<'EOF'

────────────────────────────────────────────────────────────────────────────
 Setup complete. Now run TWO terminals:

   Terminal 1 (controller API :3001 + dashboard :3003):
     bun dev

   Terminal 2 (a local node against this laptop's Docker):
     bun run dev:agent

 Then open  http://localhost:3003  and log in:
     email:    dev@swarmy.local
     password: swarmy-dev

 Watch your node turn ONLINE on the Infrastructure plane.
 Full walkthrough + troubleshooting: docs/LOCAL-SWARM.md
────────────────────────────────────────────────────────────────────────────
EOF
