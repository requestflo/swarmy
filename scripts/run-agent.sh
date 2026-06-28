#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
#
# Run a swarmy agent locally against THIS laptop's Docker socket, enrolling with
# the dev join token from `bun run dev:up` / `bun run seed-dev`.
#
# Token resolution order:
#   1. $SWARMY_JOIN_TOKEN if already set in the environment
#   2. the raw token in .swarmy-dev-token (written by seed-dev)
#
# Usage: bun run dev:agent   (or: bash scripts/run-agent.sh)

set -euo pipefail

cd "$(dirname "$0")/.."

say()  { printf '\033[1;36m▸ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── Resolve the join token ──────────────────────────────────────────────────
if [[ -n "${SWARMY_JOIN_TOKEN:-}" ]]; then
  token_source="\$SWARMY_JOIN_TOKEN"
elif [[ -f .swarmy-dev-token ]]; then
  SWARMY_JOIN_TOKEN="$(tr -d '[:space:]' < .swarmy-dev-token)"
  token_source=".swarmy-dev-token"
else
  die "No join token. Run 'bun run dev:up' (or 'bun run seed-dev'), or export SWARMY_JOIN_TOKEN=…"
fi
[[ -n "$SWARMY_JOIN_TOKEN" ]] || die "join token is empty. Re-run 'bun run seed-dev'."
export SWARMY_JOIN_TOKEN

# ── Docker socket ───────────────────────────────────────────────────────────
DOCKER_SOCKET="${DOCKER_SOCKET:-/var/run/docker.sock}"
export DOCKER_SOCKET
if [[ ! -S "$DOCKER_SOCKET" ]]; then
  die "Docker socket not found at $DOCKER_SOCKET. Is Docker running? Override with DOCKER_SOCKET=…"
fi

# ── Controller endpoint + capability flags ──────────────────────────────────
export AGENT_WS_URL="${AGENT_WS_URL:-ws://localhost:3001/agent/ws}"
# Default-off image builds + container exec; mesh is on by default (see apps/agent/src/env.ts).
export SWARMY_ALLOW_BUILD="${SWARMY_ALLOW_BUILD:-false}"
export SWARMY_ALLOW_MESH="${SWARMY_ALLOW_MESH:-true}"
export SWARMY_ALLOW_EXEC="${SWARMY_ALLOW_EXEC:-false}"

token_preview="${SWARMY_JOIN_TOKEN:0:12}…"
say "Starting local agent"
printf '    controller : %s\n' "$AGENT_WS_URL"
printf '    docker sock: %s\n' "$DOCKER_SOCKET"
printf '    join token : %s (from %s)\n' "$token_preview" "$token_source"
printf '    allow build: %s   allow mesh: %s\n' "$SWARMY_ALLOW_BUILD" "$SWARMY_ALLOW_MESH"
echo

exec bun --filter @swarmy/agent start
