import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import {
  convergeStoreDeployment,
  fireEvent,
  garageCapacityGb,
  garageMajorOf,
  resumeEngineUpgrade,
  systemContext,
  toGarageRequest,
  type GarageMajor,
} from '@swarmy/trpc';
import { decryptSecret } from '@swarmy/core/crypto';
import type { ContainerInfo, RunOnceResult } from '@swarmy/core/protocol';
import { hub } from '../gateway';
import {
  adminRunOncePayload,
  backoffTicks,
  bootstrapDuringEngineUpgrade,
  buildAdminScript,
  buildStats,
  buildTaskProbeScript,
  DEFAULT_CAPACITY_GB,
  garageAdminRoot,
  garageSelfPath,
  matchGarageNodes,
  mergeNodeMapping,
  needsRpcBootstrap,
  parseAdminOutput,
  parseGarageHealth,
  parseGarageLayout,
  parseGarageStatus,
  parseTaskProbe,
  planConnects,
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
 * `container.runOnce` curl dispatched via a manager, attached to the `swarmy`
 * overlay, hitting `swarmy-garage:3903` by swarm DNS — the store publishes NO
 * ports; the same dispatch shape buckets.service.ts uses) and converge:
 *
 *  0. BOOTSTRAP the RPC mesh (multi-member, best-effort): while fewer nodes
 *     are connected than there are members, probe every task's overlay IP and
 *     `POST /v1/connect` each member to the others (see `.core`).
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
  /** Garage image the store runs (null = legacy v1.0.1) — selects the admin dialect. */
  engineImage?: string | null;
  /** Engine-upgrade run state; while it runs, the reconcile stands down. */
  engineUpgrade?: unknown;
}

/** An engine upgrade is deliberately stopping/replacing the store: hands off. */
function engineUpgradeRunning(row: ClusterRow): boolean {
  const u = row.engineUpgrade as { status?: string } | null | undefined;
  return u?.status === 'running';
}

/**
 * One admin call via a one-shot curl container dispatched to `nodeId` (a
 * manager), attached to the store overlay. `host` targets one task's overlay
 * IP directly (RPC bootstrap); default = the service VIP.
 */
async function garageAdmin(
  nodeId: string,
  adminToken: string,
  major: GarageMajor,
  call: { method: 'GET' | 'POST'; path: string; body?: string; host?: string },
): Promise<string> {
  const req = toGarageRequest(call, major);
  const res = await hub.dispatch<RunOnceResult>(
    nodeId,
    'container.runOnce',
    adminRunOncePayload(
      buildAdminScript(),
      {
        GARAGE_ADMIN_TOKEN: adminToken,
        GARAGE_METHOD: req.method,
        GARAGE_URL: `${garageAdminRoot(call.host)}${req.path}`,
        ...(req.body ? { GARAGE_BODY: req.body } : {}),
      },
      DISPATCH_TIMEOUT_MS,
    ),
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

/** Probe every store task on the overlay and full-mesh `POST /v1/connect` them. */
async function bootstrapRpcMesh(target: string, adminToken: string, major: GarageMajor): Promise<void> {
  const res = await hub.dispatch<RunOnceResult>(
    target,
    'container.runOnce',
    adminRunOncePayload(
      buildTaskProbeScript(),
      { GARAGE_ADMIN_TOKEN: adminToken, GARAGE_SERVICE: STORE_SERVICE_NAME, GARAGE_SELF_PATH: garageSelfPath(major) },
      DISPATCH_TIMEOUT_MS,
    ),
    { timeoutMs: DISPATCH_TIMEOUT_MS + 15_000 },
  );
  for (const c of planConnects(parseTaskProbe(res.output))) {
    await garageAdmin(target, adminToken, major, {
      method: 'POST',
      path: '/connect',
      body: JSON.stringify(c.peers),
      host: c.ip,
    }).catch(() => undefined);
  }
}

/** Only the RPC bootstrap, for a store mid engine-upgrade (see `bootstrapDuringEngineUpgrade`). */
async function bootstrapOnly(row: ClusterRow): Promise<void> {
  const memberIds = Array.isArray(row.memberNodeIds) ? (row.memberNodeIds as string[]) : [];
  const target = hub.managerNode(row.orgId);
  if (!target || !row.adminTokenRef) return;
  const major = garageMajorOf(row.engineImage);
  const adminToken = decryptSecret(row.adminTokenRef);
  const health = await garageAdmin(target, adminToken, major, { method: 'GET', path: '/health' })
    .then((b) => parseGarageHealth(parseJson(b)))
    .catch(() => null);
  if (needsRpcBootstrap(memberIds.length, health)) await bootstrapRpcMesh(target, adminToken, major);
}

async function reconcileOrg(row: ClusterRow, tick: number): Promise<void> {
  const orgId = row.orgId;
  const state = stateFor(orgId);
  if (tick < state.skipUntilTick) return;
  if (!row.adminTokenRef) return;

  const memberIds = Array.isArray(row.memberNodeIds) ? (row.memberNodeIds as string[]) : [];
  // Admin one-shots run via a manager, on the swarmy overlay (nothing is
  // published on any node, so no member-local port exists to prefer).
  const target = hub.managerNode(orgId);
  if (!target) return;

  const major = garageMajorOf(row.engineImage);
  try {
    const adminToken = decryptSecret(row.adminTokenRef);

    // (0) Multi-member RPC bootstrap (best-effort; single member skips).
    const readHealth = async () =>
      parseGarageHealth(
        parseJson(await garageAdmin(target, adminToken, major, { method: 'GET', path: '/health' })),
      );
    let health = await readHealth();
    if (needsRpcBootstrap(memberIds.length, health)) {
      await bootstrapRpcMesh(target, adminToken, major).catch(() => undefined);
      health = await readHealth();
    }

    const status = parseGarageStatus(
      parseJson(await garageAdmin(target, adminToken, major, { method: 'GET', path: '/status' })),
    );
    const layout = parseGarageLayout(
      parseJson(await garageAdmin(target, adminToken, major, { method: 'GET', path: '/layout' })),
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
        // The node's real disk once it reports one (a fixed 100 GB claim let
        // Garage plan storage a 25 GB droplet can't hold); before that, the
        // recorded value / default.
        capacityGb: hub.latestNodeStats(nodeId)?.fsTotalBytes
          ? garageCapacityGb(hub.latestNodeStats(nodeId)?.fsTotalBytes)
          : (recorded[nodeId]?.capacityGb ?? DEFAULT_CAPACITY_GB),
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
            await garageAdmin(target, adminToken, major, {
              method: 'POST',
              path: '/layout',
              body: JSON.stringify(plan.stage),
            });
          }
          if (plan.applyVersion !== null) {
            await garageAdmin(target, adminToken, major, {
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
        if (engineUpgradeRunning(row)) {
          // A controller restart mid-upgrade: pick the persisted run back up
          // (idempotent steps). The reconcile itself stays hands-off meanwhile.
          await resumeEngineUpgrade(
            systemContext({ db: prisma, hub, auth: authRegistry.getAuth() }, row.orgId),
          ).catch(() => undefined);
          if (bootstrapDuringEngineUpgrade(row.engineUpgrade)) await bootstrapOnly(row).catch(() => undefined);
          continue;
        }
        // Heal legacy host-bind / unpinned store specs before probing layout.
        await convergeStoreDeployment(
          systemContext({ db: prisma, hub, auth: authRegistry.getAuth() }, row.orgId),
        ).catch(() => undefined);
        await reconcileOrg(row, t).catch(() => undefined);
      }
    })().finally(() => {
      running = false;
    });
  }, TICK_MS);
  return () => clearInterval(timer);
}
