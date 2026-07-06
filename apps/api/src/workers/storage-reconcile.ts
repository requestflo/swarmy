import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { fireEvent, systemContext } from '@swarmy/trpc';
import { decryptSecret } from '@swarmy/core/crypto';
import type { ContainerInfo, RunOnceResult } from '@swarmy/core/protocol';
import { hub } from '../gateway';
import {
  backoffTicks,
  buildAdminScript,
  buildStats,
  CURL_IMAGE,
  DEFAULT_CAPACITY_GB,
  garageAdminBase,
  matchGarageNodes,
  mergeNodeMapping,
  parseAdminOutput,
  parseGarageHealth,
  parseGarageLayout,
  parseGarageStatus,
  planLayout,
  planSignature,
  statsChanged,
  STORAGE_STATS_LABEL,
  STORE_SERVICE_NAME,
  type DesiredMember,
} from './storage-reconcile.core';

/**
 * Garage object-store reconcile worker (WS5 — Garage lifecycle).
 *
 * Every ~30s, for each org whose StorageCluster is enabled (DB-gated, like the
 * dns worker), read the LIVE Garage cluster through its admin API (a one-shot
 * `container.runOnce` curl on a store member node — the same dispatch shape
 * buckets.service.ts uses) and converge:
 *
 *  1. DISCOVER each member's Garage node id (layout zone → container-hostname
 *     match → singleton fallback) and write it back to the StorageCluster row's
 *     `layout.nodes` — the one-shot `enable()` render filters on it, so after
 *     this worker runs the filter finally has data.
 *  2. CONVERGE the cluster layout: diff desired members (zones + capacity)
 *     against the applied roles, stage additions/updates/removals
 *     (POST /v1/layout) and commit with Garage's two-step semantics
 *     (POST /v1/layout/apply, version+1). Removals are withheld while any
 *     member is undiscovered — never drop a node we merely failed to identify.
 *  3. MONITOR resync: stamp health + per-node partition/data progress as the
 *     `swarmy.storage.stats` label on the swarmy-garage service (change-gated),
 *     which `replicatedStore.service#status` folds into the router's view.
 *
 * Never flaps: an empty plan at steady state dispatches nothing, an identical
 * plan that failed to converge backs off exponentially, and the stats stamp is
 * content-gated (timestamp excluded). Pure planning/parsing lives in the
 * colocated `.core` module (the manageddb-reconcile.core pattern); constants
 * mirror `@swarmy/trpc` buckets.service.ts — a worker cannot subpath-import an
 * internal trpc module.
 */

const TICK_MS = 30_000;
const DISPATCH_TIMEOUT_MS = 45_000;
const SWARM_SERVICE_ID_LABEL = 'com.docker.swarm.service.id';

interface OrgState {
  /** Consecutive failed ticks (reset on success). */
  failures: number;
  /** Skip ticks until this tick number (backoff). */
  skipUntilTick: number;
  /** Signature of the last attempted layout plan (identical retries back off). */
  lastPlanSig: string | null;
  /** Consecutive attempts of the same plan signature. */
  planAttempts: number;
}

const orgState = new Map<string, OrgState>();

function stateFor(orgId: string): OrgState {
  const cur = orgState.get(orgId);
  if (cur) return cur;
  const fresh: OrgState = { failures: 0, skipUntilTick: 0, lastPlanSig: null, planAttempts: 0 };
  orgState.set(orgId, fresh);
  return fresh;
}

interface ClusterRow {
  orgId: string;
  memberNodeIds: unknown;
  layout: unknown;
  adminTokenRef: string | null;
}

/** One admin call via a one-shot curl container on `nodeId` (host network). */
async function garageAdmin(
  nodeId: string,
  adminToken: string,
  call: { method: 'GET' | 'POST'; path: string; body?: string },
): Promise<string> {
  const res = await hub.dispatch<RunOnceResult>(
    nodeId,
    'container.runOnce',
    {
      image: CURL_IMAGE,
      entrypoint: ['/bin/sh', '-c'],
      cmd: [buildAdminScript()],
      env: {
        GARAGE_ADMIN_TOKEN: adminToken,
        GARAGE_METHOD: call.method,
        GARAGE_URL: `${garageAdminBase()}${call.path}`,
        ...(call.body ? { GARAGE_BODY: call.body } : {}),
      },
      networks: ['host'],
      pull: true,
      timeoutMs: DISPATCH_TIMEOUT_MS,
    },
    { timeoutMs: DISPATCH_TIMEOUT_MS + 15_000 },
  );
  const { status, body } = parseAdminOutput(res.output);
  if (res.exitCode !== 0 && status === 0) {
    throw new Error(`object store unreachable: ${res.output.slice(-200) || 'curl failed'}`);
  }
  if (status >= 400) {
    throw new Error(`garage admin API ${status}: ${body.slice(0, 200) || call.path}`);
  }
  return body;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

/** Short container id of the store task on each member node (hostname source). */
function storeContainerHosts(
  orgId: string,
  memberIds: string[],
): Array<{ nodeId: string; containerIdShort: string }> {
  const svc = hub.liveInventory(orgId).services.find((s) => s.name === STORE_SERVICE_NAME);
  if (!svc) return [];
  const hosts: Array<{ nodeId: string; containerIdShort: string }> = [];
  for (const nodeId of memberIds) {
    const c = hub.latestContainers(nodeId).find((cc: ContainerInfo) => {
      const sid = cc.serviceId ?? cc.labels?.[SWARM_SERVICE_ID_LABEL];
      return sid === svc.id && cc.state === 'running';
    });
    if (c) hosts.push({ nodeId, containerIdShort: c.id.slice(0, 12) });
  }
  return hosts;
}

async function reconcileOrg(row: ClusterRow, tick: number): Promise<void> {
  const orgId = row.orgId;
  const state = stateFor(orgId);
  if (tick < state.skipUntilTick) return;
  if (!row.adminTokenRef) return;

  const memberIds = Array.isArray(row.memberNodeIds) ? (row.memberNodeIds as string[]) : [];
  // Prefer an online store member (the admin port is published there via the
  // routing mesh); fall back to any connected manager.
  const target = memberIds.find((id) => hub.isOnline(id)) ?? hub.managerNode(orgId);
  if (!target) return;

  try {
    const adminToken = decryptSecret(row.adminTokenRef);
    const status = parseGarageStatus(
      parseJson(await garageAdmin(target, adminToken, { method: 'GET', path: '/status' })),
    );
    const layout = parseGarageLayout(
      parseJson(await garageAdmin(target, adminToken, { method: 'GET', path: '/layout' })),
    );
    const health = parseGarageHealth(
      parseJson(await garageAdmin(target, adminToken, { method: 'GET', path: '/health' })),
    );

    // (1) Discover garage node ids and write newly-joined members back.
    const recorded = mergeNodeMapping(row.layout, {}, DEFAULT_CAPACITY_GB).next.nodes as Record<
      string,
      { garageNodeId?: string; capacityGb?: number }
    >;
    const known: Record<string, string> = {};
    for (const [nodeId, rec] of Object.entries(recorded)) {
      if (rec.garageNodeId) known[nodeId] = rec.garageNodeId;
    }
    const mapping = matchGarageNodes(status.nodes, storeContainerHosts(orgId, memberIds), known);
    const merge = mergeNodeMapping(row.layout, mapping, DEFAULT_CAPACITY_GB);
    if (merge.changed) {
      await prisma.storageCluster.update({
        where: { orgId },
        data: { layout: merge.next as object },
      });
    }

    // (2) Layout convergence: stage the diff, then commit version+1.
    if (layout) {
      const desired: DesiredMember[] = memberIds.map((nodeId) => ({
        nodeId,
        ...(mapping[nodeId] ? { garageNodeId: mapping[nodeId] } : {}),
        capacityGb: recorded[nodeId]?.capacityGb ?? DEFAULT_CAPACITY_GB,
      }));
      const plan = planLayout(orgId, desired, layout);
      if (plan.stage.length > 0 || plan.applyVersion !== null) {
        const sig = planSignature(plan, layout.version);
        if (sig === state.lastPlanSig) {
          // Same plan as last attempt — it did not converge; back off.
          state.planAttempts += 1;
          state.skipUntilTick = tick + backoffTicks(state.planAttempts);
        } else {
          state.lastPlanSig = sig;
          state.planAttempts = 1;
        }
        if (tick >= state.skipUntilTick) {
          if (plan.stage.length > 0) {
            await garageAdmin(target, adminToken, {
              method: 'POST',
              path: '/layout',
              body: JSON.stringify(plan.stage),
            });
          }
          if (plan.applyVersion !== null) {
            await garageAdmin(target, adminToken, {
              method: 'POST',
              path: '/layout/apply',
              body: JSON.stringify({ version: plan.applyVersion }),
            });
          }
        }
      } else {
        state.lastPlanSig = null;
        state.planAttempts = 0;
      }
    }

    // (3) Resync/health stamp on the store service (change-gated, no flap).
    const svc = hub.liveInventory(orgId).services.find((s) => s.name === STORE_SERVICE_NAME);
    if (svc) {
      const stats = buildStats(status, health, mapping, new Date().toISOString());
      if (statsChanged(svc.labels?.[STORAGE_STATS_LABEL], stats)) {
        const mgr = hub.managerNode(orgId);
        if (mgr) {
          await hub
            .dispatch(mgr, 'service.updateLabels', {
              service: svc.name,
              add: { [STORAGE_STATS_LABEL]: JSON.stringify(stats) },
              removeKeys: [],
            })
            .catch(() => undefined);
        }
      }
    }

    // Alert while the store is not fully healthy (fireEvent dedupes upstream).
    if (health && health.status !== 'healthy') {
      const ctx = systemContext({ db: prisma, hub, auth: authRegistry.getAuth() }, orgId);
      await fireEvent(ctx, {
        signal: 'storage-degraded',
        severity: health.status === 'unavailable' ? 'critical' : 'warning',
        resource: STORE_SERVICE_NAME,
        message: `Object store ${health.status}: ${health.partitionsAllOk}/${health.partitions} partitions fully synced, ${health.storageNodesOk}/${health.storageNodes} storage nodes ok`,
      }).catch(() => undefined);
    }

    state.failures = 0;
  } catch {
    state.failures += 1;
    state.skipUntilTick = tick + backoffTicks(state.failures);
  }
}

export function startStorageReconcile(): () => void {
  let tick = 0;
  let running = false;
  const timer = setInterval(() => {
    if (running) return; // a slow tick must not overlap the next one
    running = true;
    tick += 1;
    const t = tick;
    void (async () => {
      const rows = (await prisma.storageCluster
        .findMany({ where: { enabled: true } })
        .catch(() => [])) as ClusterRow[];
      for (const row of rows) {
        await reconcileOrg(row, t).catch(() => undefined);
      }
    })().finally(() => {
      running = false;
    });
  }, TICK_MS);
  return () => clearInterval(timer);
}
