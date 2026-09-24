#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
#
# e2e-cluster.sh — build a FRESH multi-node swarmy cluster on local VMs and
# prove the product end to end. One command; replaces hand-run droplet tests.
#
#   bash scripts/e2e-cluster.sh                   # 3 × 1 GiB Lima VMs, all steps, teardown
#   bash scripts/e2e-cluster.sh --keep            # leave the cluster up
#   bash scripts/e2e-cluster.sh --only postgres   # one step against a kept cluster
#   bash scripts/e2e-cluster.sh --help            # every flag + step id
#
# Needs: Lima (macOS) or Docker (dind provider), Docker for image builds, bun.
# The harness lives in apps/e2e/cluster (run.ts); this is just the front door.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
command -v bun >/dev/null 2>&1 || { echo "bun is required (https://bun.sh)" >&2; exit 2; }
command -v docker >/dev/null 2>&1 || { echo "docker is required (image builds + local registry)" >&2; exit 2; }
exec bun run "$REPO_ROOT/apps/e2e/cluster/run.ts" "$@"
