/**
 * Retire a server — the RUNNER (plans/epic-volume-mobility.md, phase 3). The
 * plan is the pure `planDecommission` (node-decommission.plan.ts); this module
 * gathers its input from live truth, then executes it ONE STEP AT A TIME,
 * re-planning before every step: the inventory changes as steps run (a
 * switched-over database is no longer on the server, so its step disappears)
 * and a new blocker stops the run instead of pressing on.
 *
 * Run state (which steps are done, the log) is an `OperationRun`
 * (kind `node.decommission`, one per org — one server at a time), never a
 * label or a config document. A controller restart leaves the run
 * `interrupted`; Resume re-plans and carries on after the last done step.
 *
 * Each step reuses an existing path: node.update (pause/drain/role/rm),
 * setNodeRole (edge labels), the phase-2 mover (volumes) and switchover (DB),
 * backups.backupVolume / restoreSnapshot, the Garage store's member set, the
 * docker CLI one-shot (`docker swarm leave`) and removeNode. Nothing on the
 * server's disk is ever deleted.
 */
import { backupTargets } from './backups.repo';
import { MOVER_IMAGE, isValidVolumeName, repinSpec, PINNED_DATA_LABELS, PG_PASSWORD_FROM_MEMBER } from '@swarmy/core';
import type { ContainerInfo, ServiceSpec } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { backupVolume, restoreSnapshot } from './backups.service';
import { resolveManagerNode } from './dispatch.service';
import { GARAGE_MEMBER_NODE_LABEL } from './garage-render';
import { setReplicas, setTopology } from './manageddb.service';
import {
  planDecommission,
  type DecomContainerInput,
  type DecomNodeInput,
  type DecomServiceInput,
  type DecomVolumeInput,
  type DecommissionInput,
  type DecommissionPlan,
  type DrainStep,
} from './node-decommission.plan';
import { removeNode, setNodeAvailability, setNodeRole } from './node.service';
import { readOperationRun, saveOperationRun } from './operation-runs';
import { dockerCliPayload } from './platform-upgrade.service';
import { STORAGE_STATS_LABEL, enable as applyStore, status as storeStatus } from './replicatedStore.service';
import { execInService } from './resilience.service';
import { liveServiceSpec } from './service-patch';
import { storageClusterRepo } from './storage-cluster.repo';
import { moveServiceData, nodesRunning, realDeps, switchoverDb, type MoverDeps } from './volumeMove.service';

const SERVICE_NAME_LABEL = 'com.docker.swarm.service.name';
const KIND = 'node.decommission' as const;
const DNS_SETTLE_MS = 60_000;
const DRAIN_TIMEOUT_MS = 10 * 60_000;
const RESYNC_TIMEOUT_MS = 6 * 60 * 60_000;
const ROLE_TIMEOUT_MS = 2 * 60_000;
const MAX_STEPS = 200;
const LOG_KEEP = 60;

export type DecomRunStatus = 'running' | 'waiting' | 'failed' | 'done' | 'stopped' | 'interrupted';

export interface DecomRun {
  runId: string;
  nodeId: string;
  hostname: string;
  status: DecomRunStatus;
  /** Step ids finished (resume skips them). */
  done: string[];
  current: { id: string; title: string } | null;
  log: { at: string; message: string; level: 'info' | 'warn' | 'error' }[];
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  startedBy: string | null;
  /** Garage layout version when this server's role was dropped (resync waits past it). */
  garageLayoutVersion?: number | null;
}

/** Runs executing in THIS process (a persisted `running` run not in here was interrupted). */
const active = new Map<string, { stop: boolean }>();

type Ctx = OrgContext;

// ── gather ───────────────────────────────────────────────────────────────────

async function volumeFacts(ctx: Ctx, nodeId: string, names: string[]): Promise<DecomVolumeInput[]> {
  if (!ctx.hub.isOnline(nodeId)) return [];
  const drivers = new Map<string, string>();
  try {
    const res = await ctx.hub.dispatch<{ volumes?: { name: string; driver: string }[] }>(nodeId, 'volume.list', { cluster: false });
    for (const v of res?.volumes ?? []) drivers.set(v.name, v.driver);
  } catch {
    // unknown drivers ⇒ treated as local by the planner
  }
  const sizes = new Map<string, number>();
  const valid = names.filter(isValidVolumeName).slice(0, 40);
  if (valid.length > 0) {
    try {
      const res = await ctx.hub.dispatch<{ exitCode: number; output?: string }>(
        nodeId,
        'container.runOnce',
        {
          image: MOVER_IMAGE,
          entrypoint: ['/bin/sh', '-c'],
          cmd: [`for d in /v/*; do printf 'SIZE %s %s\\n' "$(basename "$d")" "$(du -sk "$d" | cut -f1)"; done`],
          binds: valid.map((v) => `${v}:/v/${v}:ro`),
          user: '0:0',
          timeoutMs: 120_000,
        },
        { timeoutMs: 150_000 },
      );
      for (const m of (res?.output ?? '').matchAll(/^SIZE (\S+) (\d+)$/gm)) sizes.set(m[1]!, Number(m[2]) * 1024);
    } catch {
      // sizes unknown — the planner says so
    }
  }
  return [...new Set([...drivers.keys(), ...valid])].map((name) => ({ name, driver: drivers.get(name), sizeBytes: sizes.get(name) }));
}

export async function gatherDecommissionInput(ctx: Ctx, nodeId: string): Promise<DecommissionInput> {
  const now = Date.now();
  const rows = (await ctx.db.node.findMany({
    where: { orgId: ctx.activeOrgId },
    select: { id: true, name: true, hostname: true },
  })) as { id: string; name: string; hostname: string }[];
  if (!rows.some((r) => r.id === nodeId)) throw notFound('node', nodeId);
  const swarmNodes = ctx.hub.nodeInventory(ctx.activeOrgId, true);
  let meshPeers = new Set<string>();
  try {
    const { listPeers } = await import('./mesh.service');
    meshPeers = new Set((await listPeers(ctx)).map((p) => p.nodeId).filter(Boolean));
  } catch {
    // mesh not configured
  }
  const nodes: DecomNodeInput[] = rows.map((r) => {
    const swarmId = ctx.hub.swarmNodeIdFor(r.id);
    const stats = ctx.hub.latestNodeStats(r.id);
    return {
      nodeId: r.id,
      hostname: r.name || r.hostname,
      online: ctx.hub.isOnline(r.id),
      swarm: swarmNodes.find((n) => n.swarmNodeId === swarmId) ?? ctx.hub.nodeInfoFor(r.id),
      hostsController: ctx.hub
        .latestContainers(r.id)
        .some((c) => (c.labels?.[SERVICE_NAME_LABEL] ?? '') === 'swarmy_controller'),
      disk:
        stats?.fsTotalBytes && stats.fsUsedBytes != null
          ? { usedBytes: stats.fsUsedBytes, totalBytes: stats.fsTotalBytes }
          : null,
      meshPeer: meshPeers.has(r.id),
    };
  });
  const services: DecomServiceInput[] = ctx.hub.liveInventory(ctx.activeOrgId).services.map((s) => ({
    name: s.name,
    mode: s.mode,
    desiredReplicas: s.desiredReplicas,
    labels: s.labels,
    image: s.image,
  }));
  const containers: DecomContainerInput[] = ctx.hub.latestContainers(nodeId).map((c: ContainerInfo) => ({
    name: c.name,
    serviceName: c.labels?.[SERVICE_NAME_LABEL],
    labels: c.labels,
    image: c.image,
    mounts: c.mounts,
  }));
  const named = [
    ...new Set(
      containers.flatMap((c) => (c.mounts ?? []).filter((m) => m.type === 'volume' && m.source).map((m) => m.source!)),
    ),
  ].filter((v) => !/^[0-9a-f]{64}$/.test(v));
  const volumes = await volumeFacts(ctx, nodeId, named);

  const snaps = (await ctx.db.snapshot.findMany({
    where: { orgId: ctx.activeOrgId, status: 'SUCCEEDED', volume: { in: named.length ? named : ['__none__'] } },
    select: { volume: true, finishedAt: true, startedAt: true },
  })) as { volume: string; finishedAt: Date | null; startedAt: Date }[];
  const lastBackupAt: Record<string, number> = {};
  for (const s of snaps) {
    const t = (s.finishedAt ?? s.startedAt).getTime();
    if (!(lastBackupAt[s.volume]! >= t)) lastBackupAt[s.volume] = t;
  }
  const backupsConfigured = (await backupTargets(ctx, ctx.activeOrgId).count({ where: { orgId: ctx.activeOrgId, enabled: true } })) > 0;
  const store = await storageClusterRepo.find(ctx, ctx.activeOrgId).catch(() => null);
  return {
    targetNodeId: nodeId,
    nodes,
    services,
    containers,
    volumes,
    lastBackupAt,
    backupsConfigured,
    garageReplicationFactor: store?.replicationFactor,
    now,
  };
}

export async function planNodeDecommission(ctx: Ctx, nodeId: string): Promise<DecommissionPlan> {
  return planDecommission(await gatherDecommissionInput(ctx, nodeId));
}

// ── run state ────────────────────────────────────────────────────────────────

export async function decommissionStatus(ctx: Ctx, nodeId?: string): Promise<DecomRun | null> {
  const run = await readOperationRun<DecomRun>(ctx.db, ctx.activeOrgId, KIND);
  if (!run || (nodeId && run.nodeId !== nodeId)) return null;
  if ((run.status === 'running' || run.status === 'waiting') && !active.has(run.runId)) {
    return { ...run, status: 'interrupted' };
  }
  return run;
}

async function save(ctx: Ctx, run: DecomRun): Promise<void> {
  run.log = run.log.slice(-LOG_KEEP);
  await saveOperationRun(ctx.db, ctx.activeOrgId, KIND, run);
}

function log(run: DecomRun, message: string, level: DecomRun['log'][number]['level'] = 'info'): void {
  run.log.push({ at: new Date().toISOString(), message, level });
}

// ── step executors ───────────────────────────────────────────────────────────

export interface RunnerDeps extends MoverDeps {
  dnsSettleMs: number;
}
const defaultRunnerDeps: RunnerDeps = { ...realDeps, dnsSettleMs: DNS_SETTLE_MS };

async function waitUntil(deps: MoverDeps, ms: number, cond: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = deps.now() + ms;
  while (!(await cond())) {
    if (deps.now() > deadline) throw commandRejected(`timed out waiting for ${what}`);
    await deps.sleep(3_000);
  }
}

function psql(ctx: Ctx) {
  return (service: string, sql: string) =>
    execInService(ctx, service, `${PG_PASSWORD_FROM_MEMBER} psql -U postgres -h 127.0.0.1 -p 5432 -tAc "${sql}"`);
}

async function nodeUpdate(ctx: Ctx, nodeId: string, patch: Record<string, unknown>): Promise<void> {
  const swarmNodeId = ctx.hub.swarmNodeIdFor(nodeId);
  if (!swarmNodeId) throw commandRejected('the server has no swarm id yet');
  const via = await resolveManagerNode(ctx);
  await ctx.hub.dispatch(via.id, 'node.update', { swarmNodeId, ...patch });
}

async function repinTo(ctx: Ctx, service: string, destNodeId: string): Promise<void> {
  const live = ctx.hub.liveInventory(ctx.activeOrgId).services.find((s) => s.name === service);
  if (!live) throw notFound('service', service);
  const dest = ctx.hub.swarmNodeIdFor(destNodeId);
  if (!dest) throw commandRejected('the destination has no swarm id yet');
  const mgr = await resolveManagerNode(ctx);
  const spec = repinSpec(await liveServiceSpec(ctx, mgr.id, live), dest, PINNED_DATA_LABELS) as ServiceSpec;
  await ctx.hub.dispatch(mgr.id, 'service.deploy', { spec, pullPolicy: 'missing' });
}

interface GarageStatsLite {
  layoutVersion?: number | null;
  health?: { status?: string; partitions?: number; partitionsAllOk?: number } | null;
  nodes?: { nodeId: string | null; draining?: boolean }[];
}

function garageStats(ctx: Ctx): GarageStatsLite | null {
  const raw = ctx.hub.liveInventory(ctx.activeOrgId).services.find((s) => s.name === 'swarmy-garage')?.labels[STORAGE_STATS_LABEL];
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GarageStatsLite;
  } catch {
    return null;
  }
}

/**
 * Resync is over when storage-reconcile has applied a NEWER layout than the one
 * this server had a role in, every partition is healthy again, and the server
 * no longer shows as draining (Garage keeps a removed node draining until its
 * data is re-copied). Pure; exported for tests.
 */
export function garageResynced(stats: GarageStatsLite | null, nodeId: string, sinceVersion: number | null): boolean {
  if (!stats?.health) return false;
  const h = stats.health;
  if (h.status !== 'healthy' || !h.partitions || h.partitionsAllOk !== h.partitions) return false;
  if (sinceVersion !== null && !((stats.layoutVersion ?? 0) > sinceVersion)) return false;
  return !(stats.nodes ?? []).some((n) => n.nodeId === nodeId && n.draining);
}

type StepOutcome = { kind: 'done'; note?: string } | { kind: 'waiting'; message: string };

async function runStep(ctx: Ctx, run: DecomRun, step: DrainStep, deps: RunnerDeps): Promise<StepOutcome> {
  const target = run.nodeId;
  const say = (m: string) => log(run, m);
  switch (step.kind) {
    case 'safety-backup': {
      const t = await backupTargets(ctx, ctx.activeOrgId).findFirst({ where: { orgId: ctx.activeOrgId, enabled: true }, select: { id: true } });
      if (!t) return { kind: 'done', note: 'No backup destination — skipped.' };
      for (const v of step.volumes ?? []) {
        say(`Backing up ${v}.`);
        await backupVolume(ctx, { targetId: t.id, volume: v, nodeId: target });
      }
      return { kind: 'done' };
    }
    case 'cordon':
      await nodeUpdate(ctx, target, { availability: 'pause' });
      return { kind: 'done' };
    case 'manager-promote':
      await nodeUpdate(ctx, step.destination!.nodeId, { role: 'manager' });
      await waitUntil(deps, ROLE_TIMEOUT_MS, () => ctx.hub.nodeInfoFor(step.destination!.nodeId)?.role === 'manager', 'the promotion');
      return { kind: 'done' };
    case 'edge-handover': {
      const ingress = step.id.endsWith('swarmy.node.ingress');
      if (step.destination) {
        await setNodeRole(ctx, step.destination.nodeId, ingress ? { ingress: true } : { outlet: true });
        say(`${step.destination.hostname} now carries the ${ingress ? 'edge' : 'outlet'} role.`);
      }
      await setNodeRole(ctx, target, ingress ? { ingress: false } : { outlet: false });
      say('Waiting one DNS TTL so resolvers stop using this server.');
      await deps.sleep(deps.dnsSettleMs);
      return { kind: 'done' };
    }
    case 'garage-add-member': {
      const row = await storageClusterRepo.find(ctx, ctx.activeOrgId);
      const members = new Set(row?.memberNodeIds ?? []);
      members.add(step.destination!.nodeId);
      await storageClusterRepo.update(ctx, ctx.activeOrgId, { memberNodeIds: [...members] });
      await applyStore(ctx);
      await waitUntil(deps, 10 * 60_000, async () => {
        const st = await storeStatus(ctx);
        return st.members.some((m) => m.nodeId === step.destination!.nodeId && m.up === true);
      }, 'the new storage member to come up');
      return { kind: 'done' };
    }
    case 'garage-leave': {
      run.garageLayoutVersion = garageStats(ctx)?.layoutVersion ?? null;
      // Desired members only: storage-reconcile drops the role from the layout
      // and Garage moves the data off. The task keeps running (its member label
      // stays) until garage-await-resync says every copy is back.
      const row = await storageClusterRepo.find(ctx, ctx.activeOrgId);
      await storageClusterRepo.update(ctx, ctx.activeOrgId, {
        memberNodeIds: (row?.memberNodeIds ?? []).filter((id) => id !== target),
      });
      return { kind: 'done' };
    }
    case 'garage-await-resync': {
      const since = run.garageLayoutVersion ?? null;
      await waitUntil(deps, RESYNC_TIMEOUT_MS, () => garageResynced(garageStats(ctx), target, since), 'object storage to finish re-copying');
      await applyStore(ctx); // flips this server's member label off → its Garage task stops
      return { kind: 'done' };
    }
    case 'db-switchover':
    case 'db-standby-switchover': {
      const svc = ctx.hub.liveInventory(ctx.activeOrgId).services.find((s) => s.name === step.subject);
      if (!svc) return { kind: 'done', note: 'Already gone.' };
      const stack = svc.labels['com.docker.stack.namespace'] ?? '';
      const cluster = svc.labels['swarmy.db.cluster'] ?? '';
      await switchoverDb(
        ctx,
        { stack, cluster, avoidNodeId: target },
        {
          ...deps,
          psql: psql(ctx),
          setReplicas: async (s, c, n) => void (await setReplicas(ctx, { stack: s, cluster: c, replicas: n })),
          setTopology: async (s, c, t) => void (await setTopology(ctx, { stack: s, cluster: c, topology: t as never })),
        },
        (p) => say(p.message),
      );
      return { kind: 'done' };
    }
    case 'db-failover': {
      const svc = ctx.hub.liveInventory(ctx.activeOrgId).services.find((s) => s.name === step.subject);
      if (!svc || svc.labels['swarmy.db.role'] !== 'primary') return { kind: 'done' };
      if (svc.labels['swarmy.db.failover.pending']) {
        return { kind: 'waiting', message: `${step.subject}: the failover needs your confirmation on the app's Data tab (a replica is not provably caught up). Resume after confirming.` };
      }
      await waitUntil(deps, 5 * 60_000, () => ctx.hub.liveInventory(ctx.activeOrgId).services.find((s) => s.name === step.subject)?.labels['swarmy.db.role'] !== 'primary', 'the automatic failover');
      return { kind: 'done' };
    }
    case 'volume-copy': {
      await moveServiceData(ctx, { service: step.subject!, toNodeId: step.destination!.nodeId }, (p) => say(p.message), deps);
      return { kind: 'done' };
    }
    case 'volume-restore': {
      for (const v of step.volumes ?? []) {
        const snap = await ctx.db.snapshot.findFirst({
          where: { orgId: ctx.activeOrgId, volume: v, status: 'SUCCEEDED' },
          orderBy: { startedAt: 'desc' },
          select: { id: true },
        });
        if (!snap) throw commandRejected(`no backup of ${v} to restore`);
        say(`Restoring ${v} onto ${step.destination!.hostname}.`);
        await restoreSnapshot(ctx, { snapshotId: snap.id, nodeId: step.destination!.nodeId });
      }
      if (step.subject) await repinTo(ctx, step.subject, step.destination!.nodeId);
      return { kind: 'done' };
    }
    case 'volume-follow':
      return { kind: 'done', note: 'Network volumes re-attach when their apps move in the drain step.' };
    case 'drain': {
      await setNodeAvailability(ctx, target, 'drain');
      const replicated = new Set(
        ctx.hub.liveInventory(ctx.activeOrgId).services.filter((s) => s.mode === 'replicated').map((s) => s.name),
      );
      if (ctx.hub.isOnline(target)) {
        await waitUntil(
          deps,
          DRAIN_TIMEOUT_MS,
          () =>
            !ctx.hub
              .latestContainers(target)
              .some((c) => c.state === 'running' && replicated.has(c.labels?.[SERVICE_NAME_LABEL] ?? '')),
          'the server to empty',
        );
      }
      return { kind: 'done' };
    }
    case 'manager-demote':
      await nodeUpdate(ctx, target, { role: 'worker' });
      await waitUntil(deps, ROLE_TIMEOUT_MS, () => ctx.hub.nodeInfoFor(target)?.role !== 'manager', 'the demotion');
      return { kind: 'done' };
    case 'swarm-leave': {
      if (ctx.hub.isOnline(target)) {
        await ctx.hub
          .dispatch(target, 'container.runOnce', dockerCliPayload('docker swarm leave', {}, 60_000), { timeoutMs: 90_000 })
          .catch(() => undefined); // the agent may drop as the node leaves
        await deps.sleep(5_000);
      }
      await nodeUpdate(ctx, target, { remove: true });
      return { kind: 'done' };
    }
    case 'mesh-remove':
      return {
        kind: 'done',
        note: `Remove ${run.hostname} from your mesh control plane's peer list (swarmy's mesh drivers can't delete peers yet). Its access ends with the next step either way.`,
      };
    case 'forget':
      await removeNode(ctx, target);
      return { kind: 'done' };
  }
}

// ── the loop ─────────────────────────────────────────────────────────────────

export async function startDecommission(
  ctx: Ctx,
  input: { id: string; confirmHostname: string; acceptWarnings: boolean },
  deps: RunnerDeps = defaultRunnerDeps,
): Promise<DecomRun> {
  const existing = await decommissionStatus(ctx);
  if (existing && existing.nodeId !== input.id && ['running', 'waiting', 'interrupted'].includes(existing.status)) {
    throw commandRejected(`${existing.hostname} is being retired — one server at a time.`);
  }
  if (existing && existing.nodeId === input.id && active.has(existing.runId)) return existing;

  const plan = await planNodeDecommission(ctx, input.id);
  if (input.confirmHostname.trim() !== plan.node.hostname) {
    throw commandRejected(`type the server's name (${plan.node.hostname}) to confirm.`);
  }
  if (!plan.runnable) throw commandRejected(plan.summary);
  if (plan.warnings.length > 0 && !input.acceptWarnings) throw commandRejected('accept the warnings first.');

  const resume = existing && existing.nodeId === input.id && existing.status !== 'done' ? existing : null;
  const run: DecomRun = resume
    ? { ...resume, status: 'running', error: null, finishedAt: null }
    : {
        runId: `${Date.now().toString(36)}`,
        nodeId: input.id,
        hostname: plan.node.hostname,
        status: 'running',
        done: [],
        current: null,
        log: [],
        error: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        startedBy: ctx.user?.id ?? null,
      };
  log(run, resume ? 'Resumed.' : `Started: ${plan.summary}`);
  await save(ctx, run);
  await writeAudit(ctx, {
    action: resume ? 'node.decommission.resume' : 'node.decommission.start',
    targetType: 'node',
    targetId: input.id,
    metadata: { hostname: run.hostname, steps: plan.steps.map((s) => s.id), warnings: plan.warnings },
  });
  const handle = { stop: false };
  active.set(run.runId, handle);
  void loop(ctx, run, handle, deps).finally(() => active.delete(run.runId));
  return run;
}

export async function stopDecommission(ctx: Ctx, nodeId: string): Promise<DecomRun | null> {
  const run = await decommissionStatus(ctx, nodeId);
  if (!run) return null;
  const h = active.get(run.runId);
  if (h) {
    h.stop = true;
    return run;
  }
  if (run.status !== 'done') {
    run.status = 'stopped';
    await save(ctx, run);
  }
  return run;
}

/** Exported for tests: runs until done / failed / waiting / stopped. */
export async function loop(ctx: Ctx, run: DecomRun, handle: { stop: boolean }, deps: RunnerDeps): Promise<DecomRun> {
  for (let i = 0; i < MAX_STEPS; i++) {
    if (handle.stop) {
      run.status = 'stopped';
      run.current = null;
      log(run, 'Stopped after the last finished step. Resume any time.', 'warn');
      break;
    }
    // Once the server is out of the swarm the planner can no longer describe
    // it (no swarm membership); only forgetting it remains.
    if (run.done.some((d) => d.startsWith('swarm-leave:')) && !run.done.some((d) => d.startsWith('forget:'))) {
      const forget: DrainStep = {
        id: `forget:${run.nodeId}`,
        kind: 'forget',
        title: `Forget ${run.hostname} and revoke its access.`,
        detail: '',
        downtime: 'none',
        verify: '',
        rollback: '',
      };
      run.current = { id: forget.id, title: forget.title };
      log(run, forget.title);
      try {
        await runStep(ctx, run, forget, deps);
        run.done.push(forget.id);
        run.status = 'done';
      } catch (e) {
        run.status = 'failed';
        run.error = `${forget.title} — ${(e as Error).message}`;
        log(run, run.error, 'error');
      }
      break;
    }
    let plan: DecommissionPlan;
    try {
      plan = await planNodeDecommission(ctx, run.nodeId);
    } catch (e) {
      if (run.done.some((d) => d.startsWith('forget:'))) {
        run.status = 'done';
        break;
      }
      run.status = 'failed';
      run.error = (e as Error).message;
      break;
    }
    const next = plan.steps.find((s) => !run.done.includes(s.id));
    if (!next) {
      run.status = 'done';
      break;
    }
    // A blocker that appeared mid-run stops it — except once the server is
    // already out of the swarm (only the forget step remains).
    if (!plan.runnable && !next.id.startsWith('forget:')) {
      run.status = 'failed';
      run.error = plan.summary;
      log(run, plan.summary, 'error');
      break;
    }
    run.current = { id: next.id, title: next.title };
    log(run, next.title);
    await save(ctx, run);
    try {
      const out = await runStep(ctx, run, next, deps);
      if (out.kind === 'waiting') {
        run.status = 'waiting';
        log(run, out.message, 'warn');
        break;
      }
      if (out.note) log(run, out.note);
      run.done.push(next.id);
      await writeAudit(ctx, {
        action: 'node.decommission.step',
        targetType: 'node',
        targetId: run.nodeId,
        metadata: { step: next.id, kind: next.kind },
      });
      if (next.kind === 'forget') {
        run.status = 'done';
        break;
      }
    } catch (e) {
      run.status = 'failed';
      run.error = `${next.title} — ${(e as Error).message}`;
      log(run, run.error, 'error');
      break;
    }
    await save(ctx, run);
  }
  run.current = run.status === 'running' ? run.current : null;
  if (run.status === 'done') {
    run.finishedAt = new Date().toISOString();
    log(run, `${run.hostname} is retired. Its disk was left as it is — destroy the server at your provider when you're ready.`);
    await writeAudit(ctx, { action: 'node.decommission.done', targetType: 'node', targetId: run.nodeId, metadata: { hostname: run.hostname } });
  }
  await save(ctx, run);
  return run;
}

/** Old copies (kept after moves) that sit on `nodeId`, with whether the 7 days are up. */
export function oldCopiesOnNode(ctx: Ctx, nodeId: string, now = Date.now()) {
  const out: { service: string; volume: string; movedAt: string; promptAt: string; due: boolean }[] = [];
  for (const s of ctx.hub.liveInventory(ctx.activeOrgId).services) {
    const raw = s.labels['swarmy.move.oldCopies'];
    if (!raw) continue;
    let list: { nodeId: string; volume: string; movedAt: string; promptAt: string }[] = [];
    try {
      list = JSON.parse(raw);
    } catch {
      continue;
    }
    for (const c of list) {
      if (c.nodeId !== nodeId || nodesRunning(ctx, s.name).includes(nodeId)) continue;
      out.push({ service: s.name, volume: c.volume, movedAt: c.movedAt, promptAt: c.promptAt, due: Date.parse(c.promptAt) <= now });
    }
  }
  return out;
}
