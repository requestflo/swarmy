/**
 * Swarm-over-mesh migration — the IO runner (epic: zero-trust-networking).
 *
 * Moves a RUNNING swarm onto (or back off) the mesh data-path one node at a
 * time: enroll → snapshot → [demote] → drain → leave+rejoin on the target
 * address → restore labels + re-point pins → [promote] → `node rm` the stale
 * id. The pure rules (which nodes, what order, the single-manager rule, the
 * pin remap) live in `mesh-migration.plan.ts`.
 *
 * Persistence (docker-native-storage): the run is swarmy's own orchestration
 * state, so it rides the org's existing `MeshConfig.settings` JSON — no new
 * table. It MUST outlive the swarm node it describes: a leave wipes the
 * node's labels, so the label snapshot is persisted BEFORE the leave and read
 * back from here on resume. Every step is idempotent against live Docker
 * truth, so a run that died mid-node (controller restart, failed dispatch)
 * resumes from its last persisted step — `resumeMigration`, or the worker's
 * tick (`resumeRunningMigrations`) after a controller restart.
 *
 * Every start/resume/cancel/node-move/failure writes an audit row.
 */
import { randomToken } from '@swarmy/core/crypto';
import type { ServiceSpec, SwarmNodeInfo } from '@swarmy/core/protocol';
import { TRPCError } from '@trpc/server';
import type { OrgContext } from '../context';
import { commandRejected, mapDispatchError } from '../errors';
import { writeAudit } from './audit.service';
import { enrollNode } from './mesh.service';
import {
  labelsToRestore,
  planMeshMigration,
  planPinRemap,
  remapConstraints,
  snapshotNodeSpec,
  type MigrationDirection,
  type MigrationPlan,
  type NodeSpecSnapshot,
  type PlanNodeInput,
} from './mesh-migration.plan';
import { applyServicePatch, liveServiceSpec } from './service-patch';
import { fetchLiveJoinMaterial, SWARM_COMMAND } from './swarm.service';

// ── Persisted run state (MeshConfig.settings.swarmMigration) ────────────────

export type NodeMoveStep =
  | 'pending'
  | 'enrolling'
  | 'demoting'
  | 'draining'
  | 'rejoining'
  | 'restoring'
  | 'promoting'
  | 'cleanup'
  | 'done';

export interface NodeMoveState {
  nodeId: string;
  hostname: string;
  kind: 'manager' | 'worker';
  action: 'move' | 'enroll-only';
  step: NodeMoveStep;
  error: string | null;
  /** Target advertise/data-path addr (mesh IP); null off-mesh = agent derives its own. */
  targetAddr: string | null;
  /** Taken BEFORE the leave — the only surviving copy of the node's labels. */
  snapshot: NodeSpecSnapshot | null;
  newSwarmNodeId: string | null;
  updatedAt: string;
}

export interface MigrationRun {
  id: string;
  direction: MigrationDirection;
  status: 'running' | 'failed' | 'done' | 'canceled';
  /** Off-mesh only: flip `MeshConfig.enabled` off once every node is back. */
  disableWhenDone: boolean;
  startedAt: string;
  updatedAt: string;
  startedBy: string | null;
  error: string | null;
  nodes: NodeMoveState[];
}

const SETTINGS_KEY = 'swarmMigration';

// ── Seams (tests swap sleep/timeouts/enroll) ─────────────────────────────────

export interface MigrationSeams {
  sleep: (ms: number) => Promise<void>;
  pollMs: number;
  /** Mesh peer CONNECTED + IP after enroll. */
  meshTimeoutMs: number;
  /** Tasks off a drained node. */
  drainTimeoutMs: number;
  /** New swarm node id reported `ready`. */
  readyTimeoutMs: number;
  enroll: (ctx: OrgContext, nodeId: string) => Promise<unknown>;
}

const defaultSeams: MigrationSeams = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  pollMs: 2_000,
  meshTimeoutMs: 120_000,
  drainTimeoutMs: 180_000,
  readyTimeoutMs: 120_000,
  enroll: (ctx, nodeId) => enrollNode(ctx, { nodeId }),
};

const REJOIN_TIMEOUT_MS = 120_000;
const DEPLOY_TIMEOUT_MS = 60_000;
const SWARM_SERVICE_ID_LABEL = 'com.docker.swarm.service.id';
const CONTROLLER_SERVICE = 'swarmy_controller';
const CONNECTED = new Set(['ONLINE', 'CONNECTED']);

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const now = (): string => new Date().toISOString();

async function readSettings(ctx: OrgContext): Promise<Record<string, unknown>> {
  const row = await ctx.db.meshConfig.findUnique({ where: { orgId: ctx.activeOrgId } });
  return ((row?.settings as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
}

export async function readRun(ctx: OrgContext): Promise<MigrationRun | null> {
  const s = await readSettings(ctx);
  return (s[SETTINGS_KEY] as MigrationRun | undefined) ?? null;
}

async function saveRun(ctx: OrgContext, run: MigrationRun): Promise<void> {
  const settings = await readSettings(ctx);
  // A cancel landed while the runner held this run in memory: keep it.
  const persisted = settings[SETTINGS_KEY] as MigrationRun | undefined;
  if (persisted?.id === run.id && persisted.status === 'canceled' && run.status === 'running') {
    run.status = 'canceled';
  }
  run.updatedAt = now();
  const next = { ...settings, [SETTINGS_KEY]: run } as object;
  await ctx.db.meshConfig.upsert({
    where: { orgId: ctx.activeOrgId },
    create: { orgId: ctx.activeOrgId, driver: 'NONE', enabled: false, settings: next },
    update: { settings: next },
  });
}

// ── Live inputs → planner ────────────────────────────────────────────────────

async function planInputs(ctx: OrgContext): Promise<{ nodes: PlanNodeInput[]; services: { name: string; labels: Record<string, string> }[] }> {
  const rows = (await ctx.db.node.findMany({
    where: { orgId: ctx.activeOrgId },
    select: { id: true, hostname: true },
  })) as { id: string; hostname: string }[];
  const peers = (await ctx.db.meshPeer.findMany({ where: { orgId: ctx.activeOrgId } })) as {
    nodeId: string;
    meshIp: string | null;
    status: string;
  }[];
  const peerBy = new Map(peers.map((p) => [p.nodeId, p]));
  const nodes: PlanNodeInput[] = rows.map((r) => {
    const peer = peerBy.get(r.id);
    return {
      nodeId: r.id,
      hostname: r.hostname,
      online: ctx.hub.isOnline(r.id),
      swarm: ctx.hub.nodeInfoFor(r.id),
      meshIp: peer?.meshIp ?? null,
      meshConnected: Boolean(peer && CONNECTED.has(peer.status) && peer.meshIp),
      hostsController: ctx.hub
        .latestContainers(r.id)
        .some((c) => (c.labels?.['com.docker.swarm.service.name'] ?? '') === CONTROLLER_SERVICE),
    };
  });
  const services = ctx.hub.liveInventory(ctx.activeOrgId).services.map((s) => ({ name: s.name, labels: s.labels }));
  return { nodes, services };
}

export async function previewMigration(ctx: OrgContext, direction: MigrationDirection): Promise<MigrationPlan> {
  const { nodes, services } = await planInputs(ctx);
  return planMeshMigration({ direction, nodes, services });
}

export interface SwarmMeshStatus {
  meshEnabled: boolean;
  driver: string;
  plan: MigrationPlan;
  run: MigrationRun | null;
}

/** Live per-node picture + the persisted run (drives the "Swarm on mesh" card). */
export async function swarmMeshStatus(ctx: OrgContext, direction?: MigrationDirection): Promise<SwarmMeshStatus> {
  const row = await ctx.db.meshConfig.findUnique({ where: { orgId: ctx.activeOrgId } });
  const run = await readRun(ctx);
  const dir = direction ?? (run?.status === 'running' || run?.status === 'failed' ? run.direction : 'onto-mesh');
  return {
    meshEnabled: Boolean(row?.enabled) && (row?.driver ?? 'NONE') !== 'NONE',
    driver: (row?.driver ?? 'NONE').toLowerCase(),
    plan: await previewMigration(ctx, dir),
    run,
  };
}

// ── Start / resume / cancel ──────────────────────────────────────────────────

const inFlight = new Set<string>();

function kick(ctx: OrgContext, seams?: Partial<MigrationSeams>): void {
  if (inFlight.has(ctx.activeOrgId)) return;
  void runMeshMigration(ctx, seams).catch((e) => {
    console.warn(`[mesh-migration] org ${ctx.activeOrgId}: ${errMsg(e)}`);
  });
}

export async function startMigration(
  ctx: OrgContext,
  input: { direction: MigrationDirection; acknowledgeWarnings?: boolean; disableWhenDone?: boolean },
  seams?: Partial<MigrationSeams>,
): Promise<MigrationRun> {
  const row = await ctx.db.meshConfig.findUnique({ where: { orgId: ctx.activeOrgId } });
  if (input.direction === 'onto-mesh' && (!row?.enabled || row.driver === 'NONE')) {
    throw commandRejected('Turn the mesh on (and add the control-plane token) before moving the swarm onto it.');
  }
  const existing = await readRun(ctx);
  if (existing && (existing.status === 'running' || existing.status === 'failed')) {
    throw commandRejected(
      existing.status === 'running'
        ? 'A swarm move is already running.'
        : 'A previous swarm move stopped part-way — resume or cancel it first.',
    );
  }
  const plan = await previewMigration(ctx, input.direction);
  if (plan.blockers.length > 0) throw commandRejected(plan.blockers.join(' '));
  const stuck = plan.nodes.filter((n) => n.onMesh && n.action === 'stays-put');
  if (input.direction === 'off-mesh' && input.disableWhenDone && stuck.length > 0) {
    throw commandRejected(
      `${stuck.map((n) => n.hostname).join(', ')} advertise${stuck.length === 1 ? 's' : ''} on the mesh and can't be moved with fewer than 3 managers — the mesh has to stay on.`,
    );
  }
  if (plan.warnings.length > 0 && !input.acknowledgeWarnings) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: plan.warnings.join(' ') });
  }
  const work = plan.nodes.filter((n) => n.action === 'move' || n.action === 'enroll-only');
  const run: MigrationRun = {
    id: randomToken('mig'),
    direction: input.direction,
    status: work.length > 0 ? 'running' : 'done',
    disableWhenDone: input.direction === 'off-mesh' && Boolean(input.disableWhenDone),
    startedAt: now(),
    updatedAt: now(),
    startedBy: ctx.user?.id ?? null,
    error: null,
    nodes: work.map((n) => ({
      nodeId: n.nodeId,
      hostname: n.hostname,
      kind: n.kind,
      action: n.action as 'move' | 'enroll-only',
      step: 'pending',
      error: null,
      targetAddr: input.direction === 'onto-mesh' ? n.meshIp : null,
      snapshot: null,
      newSwarmNodeId: null,
      updatedAt: now(),
    })),
  };
  await saveRun(ctx, run);
  await writeAudit(ctx, {
    action: 'mesh.migration.start',
    targetType: 'meshConfig',
    targetId: ctx.activeOrgId,
    metadata: {
      runId: run.id,
      direction: run.direction,
      nodes: run.nodes.map((n) => ({ nodeId: n.nodeId, action: n.action })),
      warningsAcknowledged: plan.warnings.length,
    },
  });
  if (run.status === 'running') kick(ctx, seams);
  else if (run.disableWhenDone) await finishDisable(ctx);
  return run;
}

export async function resumeMigration(ctx: OrgContext, seams?: Partial<MigrationSeams>): Promise<MigrationRun> {
  const run = await readRun(ctx);
  if (!run || run.status === 'done') {
    throw commandRejected('There is no stopped swarm move to resume.');
  }
  run.status = 'running';
  run.error = null;
  for (const n of run.nodes) n.error = null;
  await saveRun(ctx, run);
  await writeAudit(ctx, {
    action: 'mesh.migration.resume',
    targetType: 'meshConfig',
    targetId: ctx.activeOrgId,
    metadata: { runId: run.id },
  });
  kick(ctx, seams);
  return run;
}

/** Stop after the current node (nodes mid-move are never abandoned half-way by us). */
export async function cancelMigration(ctx: OrgContext): Promise<MigrationRun> {
  const run = await readRun(ctx);
  if (!run || run.status === 'done' || run.status === 'canceled') {
    throw commandRejected('There is no swarm move to cancel.');
  }
  run.status = 'canceled';
  await saveRun(ctx, run);
  await writeAudit(ctx, {
    action: 'mesh.migration.cancel',
    targetType: 'meshConfig',
    targetId: ctx.activeOrgId,
    metadata: { runId: run.id, at: run.nodes.find((n) => n.step !== 'done' && n.step !== 'pending')?.nodeId ?? null },
  });
  return run;
}

async function finishDisable(ctx: OrgContext): Promise<void> {
  await ctx.db.meshConfig.update({ where: { orgId: ctx.activeOrgId }, data: { enabled: false } });
  await writeAudit(ctx, {
    action: 'mesh.setEnabled',
    targetType: 'meshConfig',
    targetId: ctx.activeOrgId,
    metadata: { enabled: false, via: 'mesh.migration' },
  });
}

// ── The runner ───────────────────────────────────────────────────────────────

/**
 * Advance the org's run to completion or its first failure. One node at a
 * time; each node walks its step ladder, persisting after every step.
 * Process-local lock per org (the worker tick and a UI kick never overlap).
 */
export async function runMeshMigration(ctx: OrgContext, seamsIn?: Partial<MigrationSeams>): Promise<MigrationRun | null> {
  const seams: MigrationSeams = { ...defaultSeams, ...seamsIn };
  if (inFlight.has(ctx.activeOrgId)) return null;
  inFlight.add(ctx.activeOrgId);
  try {
    let run = await readRun(ctx);
    if (!run || run.status !== 'running') return run;
    for (const node of run.nodes) {
      if (node.step === 'done') continue;
      // Re-read: a cancel lands between nodes.
      const latest = await readRun(ctx);
      if (!latest || latest.id !== run.id || latest.status !== 'running') return latest;
      try {
        await moveNode(ctx, run, node, seams);
      } catch (e) {
        node.error = errMsg(e);
        run.status = 'failed';
        run.error = `${node.hostname}: ${node.error}`;
        await saveRun(ctx, run);
        await writeAudit(ctx, {
          action: 'mesh.migration.failed',
          actorType: 'system',
          targetType: 'node',
          targetId: node.nodeId,
          metadata: { runId: run.id, step: node.step, error: node.error },
        });
        await undrainIfStillOld(ctx, node).catch(() => undefined);
        return run;
      }
      run = (await readRun(ctx)) ?? run;
    }
    run.status = 'done';
    await saveRun(ctx, run);
    await writeAudit(ctx, {
      action: 'mesh.migration.done',
      actorType: 'system',
      targetType: 'meshConfig',
      targetId: ctx.activeOrgId,
      metadata: { runId: run.id, direction: run.direction, nodes: run.nodes.length },
    });
    if (run.disableWhenDone) await finishDisable(ctx);
    return run;
  } finally {
    inFlight.delete(ctx.activeOrgId);
  }
}

/** A manager (≠ the node being moved) to route node-level writes through. */
function viaManager(ctx: OrgContext, excludeNodeId: string): string {
  const via = ctx.hub.managerNodes(ctx.activeOrgId).find((id) => id !== excludeNodeId && ctx.hub.isOnline(id));
  if (!via) throw commandRejected('no other swarm manager is online to drive this node’s move');
  return via;
}

function swarmNode(ctx: OrgContext, swarmNodeId: string): SwarmNodeInfo | undefined {
  return ctx.hub.nodeInventory(ctx.activeOrgId, true).find((n) => n.swarmNodeId === swarmNodeId);
}

async function waitFor(
  seams: MigrationSeams,
  timeoutMs: number,
  what: string,
  cond: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await seams.sleep(seams.pollMs);
  }
}

async function dispatch<R = unknown>(
  ctx: OrgContext,
  nodeId: string,
  cmd: Parameters<OrgContext['hub']['dispatch']>[1],
  payload: unknown,
  timeoutMs?: number,
): Promise<R> {
  try {
    return await ctx.hub.dispatch<R>(nodeId, cmd, payload, timeoutMs ? { timeoutMs } : undefined);
  } catch (e) {
    throw mapDispatchError(e);
  }
}

async function step(ctx: OrgContext, run: MigrationRun, node: NodeMoveState, next: NodeMoveStep): Promise<void> {
  node.step = next;
  node.updatedAt = now();
  await saveRun(ctx, run);
}

function runningTasks(ctx: OrgContext, nodeId: string): number {
  return ctx.hub
    .latestContainers(nodeId)
    .filter((c) => c.state === 'running' && Boolean(c.serviceId ?? c.labels?.[SWARM_SERVICE_ID_LABEL])).length;
}

async function moveNode(ctx: OrgContext, run: MigrationRun, node: NodeMoveState, seams: MigrationSeams): Promise<void> {
  const orgId = ctx.activeOrgId;
  if (!ctx.hub.isOnline(node.nodeId)) throw new Error('node is offline');

  // 1 ─ mesh enrollment (onto-mesh only): the node needs a CONNECTED mesh IP.
  if (node.step === 'pending' || node.step === 'enrolling') {
    await step(ctx, run, node, 'enrolling');
    if (run.direction === 'onto-mesh') {
      const peer = await ctx.db.meshPeer.findUnique({ where: { nodeId: node.nodeId } });
      if (!(peer && CONNECTED.has(peer.status) && peer.meshIp)) await seams.enroll(ctx, node.nodeId);
      let meshIp: string | null = null;
      await waitFor(seams, seams.meshTimeoutMs, 'the node’s mesh peer to connect', async () => {
        const p = await ctx.db.meshPeer.findUnique({ where: { nodeId: node.nodeId } });
        meshIp = p && CONNECTED.has(p.status) ? p.meshIp : null;
        return Boolean(meshIp);
      });
      node.targetAddr = meshIp;
    }
    if (node.action === 'enroll-only') {
      await step(ctx, run, node, 'done');
      return;
    }
    // Snapshot BEFORE anything destructive; persisted with the step.
    const info = ctx.hub.nodeInfoFor(node.nodeId);
    if (!info) throw new Error('node has not reported its swarm membership');
    node.snapshot = snapshotNodeSpec(info);
    await step(ctx, run, node, node.kind === 'manager' ? 'demoting' : 'draining');
  }
  const snap = node.snapshot;
  if (!snap) throw new Error('lost the node’s label snapshot — cannot continue safely');

  // 2 ─ managers: demote (via ANOTHER manager) so the leave is allowed.
  if (node.step === 'demoting') {
    const via = viaManager(ctx, node.nodeId);
    if (swarmNode(ctx, snap.swarmNodeId)?.role !== 'worker') {
      await dispatch(ctx, via, 'node.update', { swarmNodeId: snap.swarmNodeId, role: 'worker' });
    }
    await waitFor(seams, seams.readyTimeoutMs, 'the demotion to land', () => swarmNode(ctx, snap.swarmNodeId)?.role === 'worker');
    await step(ctx, run, node, 'draining');
  }

  // 3 ─ drain and wait for its tasks to go (pinned ones stop — they can't move).
  if (node.step === 'draining') {
    const via = viaManager(ctx, node.nodeId);
    await dispatch(ctx, via, 'node.update', { swarmNodeId: snap.swarmNodeId, availability: 'drain' });
    await waitFor(seams, seams.drainTimeoutMs, 'tasks to drain off the node', () => runningTasks(ctx, node.nodeId) === 0).catch(
      () => undefined, // the leave stops whatever is left — never wedge on a slow task
    );
    await step(ctx, run, node, 'rejoining');
  }

  // 4 ─ leave + rejoin on the target address with FRESH join material.
  if (node.step === 'rejoining') {
    if (!node.newSwarmNodeId) {
      const via = viaManager(ctx, node.nodeId);
      const { token, managerAddr } = await fetchLiveJoinMaterial({ db: ctx.db as never, hub: ctx.hub, orgId }, via, 'worker');
      const res = await dispatch<{ swarmNodeId: string }>(
        ctx,
        node.nodeId,
        SWARM_COMMAND,
        {
          mode: 'join',
          role: 'worker',
          joinToken: token,
          managerAddr,
          rejoin: true,
          ...(node.targetAddr ? { advertiseAddr: node.targetAddr, dataPathAddr: node.targetAddr } : {}),
        },
        REJOIN_TIMEOUT_MS,
      );
      if (!res?.swarmNodeId || res.swarmNodeId === snap.swarmNodeId) {
        throw new Error(
          'the node did not rejoin (same swarm id back) — its agent predates the swarm re-pin; upgrade the agent and resume',
        );
      }
      node.newSwarmNodeId = res.swarmNodeId;
      await saveRun(ctx, run);
    }
    const newId = node.newSwarmNodeId;
    await waitFor(seams, seams.readyTimeoutMs, 'the rejoined node to report ready', () => swarmNode(ctx, newId)?.status === 'ready');
    await step(ctx, run, node, 'restoring');
  }
  const newId = node.newSwarmNodeId;
  if (!newId) throw new Error('rejoin did not record the new swarm node id');

  // 5 ─ restore labels, re-point pins, restore availability.
  if (node.step === 'restoring') {
    const via = viaManager(ctx, node.nodeId);
    const labels = labelsToRestore(snap, swarmNode(ctx, newId)?.labels);
    await dispatch(ctx, via, 'node.update', {
      swarmNodeId: newId,
      availability: snap.availability,
      ...(Object.keys(labels).length > 0 ? { labels } : {}),
    });
    await remapPins(ctx, via, snap.swarmNodeId, newId);
    await step(ctx, run, node, node.kind === 'manager' ? 'promoting' : 'cleanup');
  }

  // 6 ─ managers: promote back.
  if (node.step === 'promoting') {
    const via = viaManager(ctx, node.nodeId);
    if (swarmNode(ctx, newId)?.role !== 'manager') {
      await dispatch(ctx, via, 'node.update', { swarmNodeId: newId, role: 'manager' });
    }
    await waitFor(seams, seams.readyTimeoutMs, 'the promotion to land', () => swarmNode(ctx, newId)?.role === 'manager');
    await step(ctx, run, node, 'cleanup');
  }

  // 7 ─ drop the stale (down) entry for the old id.
  if (node.step === 'cleanup') {
    if (swarmNode(ctx, snap.swarmNodeId)) {
      const via = viaManager(ctx, node.nodeId);
      await dispatch(ctx, via, 'node.update', { swarmNodeId: snap.swarmNodeId, remove: true }).catch((e) => {
        // Already gone is success; anything else is worth a line but not a stop.
        console.warn(`[mesh-migration] node rm ${snap.swarmNodeId}: ${errMsg(e)}`);
      });
    }
    await step(ctx, run, node, 'done');
    await writeAudit(ctx, {
      action: run.direction === 'onto-mesh' ? 'mesh.migration.nodeMoved' : 'mesh.migration.nodeRestored',
      actorType: 'system',
      targetType: 'node',
      targetId: node.nodeId,
      metadata: {
        runId: run.id,
        fromSwarmNodeId: snap.swarmNodeId,
        toSwarmNodeId: newId,
        fromAddr: snap.addr,
        toAddr: node.targetAddr,
        labelsRestored: Object.keys(snap.labels).length,
      },
    });
  }
}

/** Re-point every service pinned to `oldId` at `newId` (labels + node.id constraints). */
export async function remapPins(ctx: OrgContext, via: string, oldId: string, newId: string): Promise<string[]> {
  const services = ctx.hub.liveInventory(ctx.activeOrgId).services;
  const remaps = planPinRemap(services, oldId, newId);
  for (const r of remaps) {
    const svc = services.find((s) => s.name === r.service);
    if (!svc) continue;
    const live = await liveServiceSpec(ctx, via, svc);
    const spec: ServiceSpec = applyServicePatch(live, {
      setLabels: r.setLabels,
      transform: (s) =>
        s.placement?.constraints
          ? { ...s, placement: { ...s.placement, constraints: remapConstraints(s.placement.constraints, oldId, newId) } }
          : s,
    });
    await dispatch(ctx, via, 'service.deploy', { spec, pullPolicy: 'missing' }, DEPLOY_TIMEOUT_MS);
    await writeAudit(ctx, {
      action: 'data.pinNode',
      actorType: 'system',
      targetType: 'service',
      targetId: r.service,
      metadata: { from: oldId, to: newId, labels: Object.keys(r.setLabels), reason: 'mesh-migration-rejoin' },
    });
  }
  return remaps.map((r) => r.service);
}

/** After a failure before the rejoin: put a node we drained back into service. */
async function undrainIfStillOld(ctx: OrgContext, node: NodeMoveState): Promise<void> {
  if (!node.snapshot || node.newSwarmNodeId) return;
  if (node.step !== 'draining' && node.step !== 'rejoining') return;
  const current = swarmNode(ctx, node.snapshot.swarmNodeId);
  if (!current || current.status !== 'ready' || current.availability === node.snapshot.availability) return;
  const via = viaManager(ctx, node.nodeId);
  await dispatch(ctx, via, 'node.update', {
    swarmNodeId: node.snapshot.swarmNodeId,
    availability: node.snapshot.availability,
  });
}

// ── Worker entry (resume after a controller restart) ────────────────────────

/** Resume every org whose run is `running` but has no in-process runner. */
export async function resumeRunningMigrations(makeCtx: (orgId: string) => OrgContext, db: OrgContext['db']): Promise<void> {
  const rows = (await db.meshConfig.findMany({ select: { orgId: true, settings: true } })) as {
    orgId: string;
    settings: unknown;
  }[];
  for (const r of rows) {
    const run = (r.settings as Record<string, unknown> | null)?.[SETTINGS_KEY] as MigrationRun | undefined;
    if (run?.status !== 'running' || inFlight.has(r.orgId)) continue;
    kick(makeCtx(r.orgId));
  }
}

/** Whether any node still advertises on the mesh (guards turning the mesh off). */
export async function nodesOnMesh(ctx: OrgContext): Promise<string[]> {
  const plan = await previewMigration(ctx, 'off-mesh');
  return plan.nodes.filter((n) => n.onMesh).map((n) => n.hostname);
}
