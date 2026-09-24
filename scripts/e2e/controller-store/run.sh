#!/usr/bin/env bash
# Controller-store e2e (resilience P3). Needs local Docker; touches nothing
# outside its own containers/volumes.
#   1. harness.ts     — Litestream ↔ Garage: crash, clean move, stale volume, fence
#   2. lease-swarm.ts — the raft lease + move through the real agent handler on
#                       a throwaway 2-manager Swarm (docker-in-docker)
set -euo pipefail
cd "$(dirname "$0")/../../.."
ROOT="$PWD"

echo "== 1/2 Litestream ↔ Garage failover"
[ "${ONLY:-}" = lease ] || bun run scripts/e2e/controller-store/harness.ts

echo "== 2/2 raft lease on a real Swarm (2 managers, dind)"
NET=swarmy-cs-e2e-net
cleanup() { docker rm -f swarmy-cs-e2e-m1 swarmy-cs-e2e-m2 >/dev/null 2>&1 || true; docker volume rm swarmy-cs-e2e-sock >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
docker network create "$NET" >/dev/null
docker volume create swarmy-cs-e2e-sock >/dev/null
docker run -d --privileged --name swarmy-cs-e2e-m1 --network "$NET" -e DOCKER_TLS_CERTDIR= -v swarmy-cs-e2e-sock:/var/run docker:27-dind >/dev/null
docker run -d --privileged --name swarmy-cs-e2e-m2 --network "$NET" -e DOCKER_TLS_CERTDIR= docker:27-dind >/dev/null
for c in swarmy-cs-e2e-m1 swarmy-cs-e2e-m2; do for _ in $(seq 1 40); do docker exec "$c" docker info >/dev/null 2>&1 && break; sleep 1; done; done
ip1="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" swarmy-cs-e2e-m1)"
docker exec swarmy-cs-e2e-m1 docker swarm init --advertise-addr "$ip1" >/dev/null
tok="$(docker exec swarmy-cs-e2e-m1 docker swarm join-token -q manager)"
docker exec swarmy-cs-e2e-m2 docker swarm join --token "$tok" "$ip1:2377" >/dev/null
for c in swarmy-cs-e2e-m1 swarmy-cs-e2e-m2; do docker exec "$c" docker pull -q busybox:latest >/dev/null; done
docker run --rm -v swarmy-cs-e2e-sock:/var/run -v "$ROOT":/repo -w /repo oven/bun:1.3-alpine \
  bun run scripts/e2e/controller-store/lease-swarm.ts
