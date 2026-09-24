/**
 * Move a service's data to another server (plans/epic-volume-mobility.md,
 * phase 2) — the IO runner. The pure half (scripts, parsers, manifests,
 * re-pin, labels) is `@swarmy/core` `volume-move.ts`.
 *
 * Two strategies:
 *
 *   {@link moveServiceData}  any volume-backed service (compose apps, search,
 *                            vector, caches, the registry…): two-pass rsync
 *                            over the `swarmy` overlay, a short stop for the
 *                            final pass, a manifest compare on both sides,
 *                            re-pin, start on the destination.
 *   {@link switchoverDb}     a managed Postgres primary: make sure a replica
 *                            runs elsewhere (adding one if needed), freeze
 *                            writes, wait until the replica has replayed the
 *                            primary's final position, stop the primary and
 *                            let manageddb-reconcile promote through
 *                            `decideFailover` (the `swarmy.db.switchover`
 *                            label only skips the grace window). The demoted
 *                            member is then un-pinned from the old server.
 *
 * Built on existing commands only (`service.deploy/scale/remove/updateLabels`,
 * `secret.create/remove`, `container.runOnce`, `volume.remove`, `exec`) — no
 * new privileged agent capability. Invariants:
 *   - the source copy is NEVER deleted: it is recorded in
 *     `swarmy.move.oldCopies` and the owner is prompted after 7 days;
 *   - a destination volume that already holds data is refused, never merged;
 *   - any failure before the app starts on the destination rolls back to the
 *     source (which was not written after the stop) and removes only the
 *     destination copies this move created;
 *   - rsync password: a Docker secret for the daemon, container env for the
 *     client — never argv, never a file on a node's disk, never logged.
 */
import { randomBytes } from 'node:crypto';
import {
  DB_AVOID_NODE_LABEL,
  DB_PIN_NODE_LABEL,
  DB_SWITCHOVER_LABEL,
  MOVE_OLD_COPIES_LABEL,
  MOVE_STATE_LABEL,
  MOVER_DST,
  MOVER_IMAGE,
  MOVER_SECRET_TARGET,
  MOVER_SRC_ROOT,
  PINNED_DATA_LABELS,
  STACK_LABEL,
  SWARMY_OVERLAY_NETWORK,
  SYSTEM_STACK,
  SYSTEM_STACK_LABEL,
  addOldCopies,
  behindWatermarkBytes,
  compareManifests,
  isValidVolumeName,
  manifestScript,
  moverSecretName,
  moverServiceName,
  newMoveId,
  oldCopy,
  parseManifest,
  parseRsyncStats,
  pullScript,
  repinSpec,
  serveScript,
  type MoveState,
  type MoveStep,
  type VolumeManifest,
} from '@swarmy/core';
import type { ContainerInfo, ServiceSpec, SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { resolveManagerNode } from './dispatch.service';
import { liveServiceSpec } from './service-patch';

const SERVICE_NAME_LABEL = 'com.docker.swarm.service.name';
const ANON_VOLUME_RE = /^[0-9a-f]{64}$/;
/** A copy pass may run this long (big volumes over a slow link). */
export const COPY_TIMEOUT_MS = 6 * 60 * 60_000;
const MANIFEST_TIMEOUT_MS = 60 * 60_000;
const STOP_TIMEOUT_MS = 120_000;
const START_TIMEOUT_MS = 180_000;
const POLL_MS = 2_000;

/** Injectable clock/sleep so the orchestration is testable without waiting. */
export interface MoverDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  secret(): string;
}
export const realDeps: MoverDeps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  secret: () => randomBytes(24).toString('base64url'),
};

export interface MoveProgress {
  moveId: string;
  step: MoveStep | 'rollback';
  message: string;
  volume?: string;
  bytes?: number;
}
export type ProgressFn = (p: MoveProgress) => void;

export interface MoveResult {
  moveId: string;
  service: string;
  from: { nodeId: string; hostname: string };
  to: { nodeId: string; hostname: string };
  volumes: { name: string; manifest: VolumeManifest }[];
  /** Seconds the service was stopped. */
  pausedSeconds: number;
}

type Ctx = OrgContext;

function hostnameOf(ctx: Ctx, nodeId: string): string {
  return ctx.hub.nodeInfoFor(nodeId)?.hostname ?? nodeId;
}

function liveService(ctx: Ctx, name: string): SwarmServiceInfo | undefined {
  return ctx.hub.liveInventory(ctx.activeOrgId).services.find((s) => s.name === name);
}

/** Controller node ids with a RUNNING task of `service`. */
export function nodesRunning(ctx: Pick<Ctx, 'hub'>, service: string): string[] {
  return ctx.hub.onlineNodeIds().filter((id) =>
    ctx.hub
      .latestContainers(id)
      .some((c: ContainerInfo) => c.labels?.[SERVICE_NAME_LABEL] === service && c.state === 'running'),
  );
}

/** Controller node id for a swarm node id. */
function nodeForSwarmId(ctx: Pick<Ctx, 'hub'>, swarmId: string): string | undefined {
  return ctx.hub.onlineNodeIds().find((id) => ctx.hub.swarmNodeIdFor(id) === swarmId);
}

/** Named local volumes a service mounts (spec truth, else its running container). */
export function serviceVolumes(ctx: Pick<Ctx, 'hub'>, svc: SwarmServiceInfo, onNode?: string): string[] {
  let mounts = svc.mounts;
  if (!mounts && onNode) {
    mounts = ctx.hub.latestContainers(onNode).find((c) => c.labels?.[SERVICE_NAME_LABEL] === svc.name)?.mounts;
  }
  return [
    ...new Set(
      (mounts ?? [])
        .filter((m) => (m.type ?? 'volume') === 'volume' && m.source && !ANON_VOLUME_RE.test(m.source))
        .map((m) => m.source!),
    ),
  ].filter(isValidVolumeName);
}

async function runOnce(
  ctx: Ctx,
  nodeId: string,
  script: string,
  opts: { binds: string[]; env?: Record<string, string>; network?: boolean; timeoutMs: number },
): Promise<{ exitCode: number; output: string }> {
  const res = await ctx.hub.dispatch<{ exitCode: number; output?: string }>(
    nodeId,
    'container.runOnce',
    {
      image: MOVER_IMAGE,
      entrypoint: ['/bin/sh', '-c'],
      cmd: [script],
      env: opts.env,
      binds: opts.binds,
      networks: opts.network ? [SWARMY_OVERLAY_NETWORK] : undefined,
      user: '0:0',
      timeoutMs: opts.timeoutMs,
    },
    { timeoutMs: opts.timeoutMs + 30_000 },
  );
  return { exitCode: res?.exitCode ?? -1, output: res?.output ?? '' };
}

async function manifestOn(ctx: Ctx, nodeId: string, volume: string, checksum: boolean): Promise<VolumeManifest> {
  const out = await runOnce(ctx, nodeId, manifestScript(checksum), {
    binds: [`${volume}:${MOVER_DST}:ro`],
    timeoutMs: MANIFEST_TIMEOUT_MS,
  });
  const m = parseManifest(out.output);
  if (out.exitCode !== 0 || !m) throw commandRejected(`could not read ${volume} on ${hostnameOf(ctx, nodeId)}: ${out.output.slice(-300)}`);
  return m;
}

async function waitFor(deps: MoverDeps, timeoutMs: number, cond: () => boolean, what: string): Promise<void> {
  const deadline = deps.now() + timeoutMs;
  while (!cond()) {
    if (deps.now() > deadline) throw commandRejected(`timed out waiting for ${what}`);
    await deps.sleep(POLL_MS);
  }
}

/** Serve service spec: rsync daemon, read-only mounts, pinned to the source. Pure. */
export function serveSpec(moveId: string, volumes: readonly string[], sourceSwarmId: string): ServiceSpec {
  return {
    name: moverServiceName(moveId),
    image: MOVER_IMAGE,
    mode: { replicated: { replicas: 1 } },
    command: ['/bin/sh', '-c', serveScript(volumes)],
    labels: {
      [STACK_LABEL]: SYSTEM_STACK,
      [SYSTEM_STACK_LABEL]: 'true',
      'swarmy.move.id': moveId,
      'swarmy.scaleToZero.exempt': 'true',
    },
    mounts: volumes.map((v) => ({ type: 'volume' as const, source: v, target: `${MOVER_SRC_ROOT}/${v}`, readOnly: true })),
    networks: [SWARMY_OVERLAY_NETWORK],
    secrets: [{ source: moverSecretName(moveId), target: MOVER_SECRET_TARGET }],
    placement: { constraints: [`node.id==${sourceSwarmId}`] },
    restartPolicy: { condition: 'on-failure', maxAttempts: 3 },
  } as ServiceSpec;
}

/**
 * Two-pass copy of a service's volumes to `toNodeId`, then start it there.
 * Resolves when the service runs on the destination; throws after rolling back.
 */
export async function moveServiceData(
  ctx: Ctx,
  input: { service: string; toNodeId: string; checksum?: boolean; bwlimitKbps?: number },
  progress: ProgressFn = () => {},
  deps: MoverDeps = realDeps,
): Promise<MoveResult> {
  const svc = liveService(ctx, input.service);
  if (!svc) throw notFound('service', input.service);
  if (svc.mode === 'global') throw commandRejected(`${svc.name} runs on every server; there is nothing to move.`);
  if (svc.labels['swarmy.db.role'] === 'primary') {
    throw commandRejected(`${svc.name} is a managed Postgres primary — move it with a switchover instead.`);
  }
  if (svc.labels[MOVE_STATE_LABEL]) throw commandRejected(`${svc.name} is already being moved.`);
  const replicas = svc.desiredReplicas ?? 1;
  const pinned = PINNED_DATA_LABELS.find((k) => svc.labels[k]);
  if (replicas > 1 && !pinned) {
    throw commandRejected(`${svc.name} runs ${replicas} copies, each with its own volume — there is no single copy to move.`);
  }

  // Where the data is: the running task, else the declared pin.
  const running = nodesRunning(ctx, svc.name);
  const fromNodeId = running[0] ?? (pinned ? nodeForSwarmId(ctx, svc.labels[pinned]!) : undefined);
  if (!fromNodeId) throw commandRejected(`${svc.name} is not running and has no pin, so swarmy cannot tell which server holds its data.`);
  if (running.length > 1) throw commandRejected(`${svc.name} runs on more than one server; swarmy cannot tell which copy is authoritative.`);
  const toNodeId = input.toNodeId;
  if (toNodeId === fromNodeId) throw commandRejected(`${svc.name} is already on ${hostnameOf(ctx, toNodeId)}.`);
  if (!ctx.hub.isOnline(toNodeId)) throw commandRejected(`${hostnameOf(ctx, toNodeId)} is offline.`);
  const destInfo = ctx.hub.nodeInfoFor(toNodeId);
  const destSwarm = ctx.hub.swarmNodeIdFor(toNodeId);
  const srcSwarm = ctx.hub.swarmNodeIdFor(fromNodeId);
  if (!destSwarm || !srcSwarm) throw commandRejected('a server has not reported its swarm membership yet.');
  if (destInfo && (destInfo.availability !== 'active' || destInfo.status !== 'ready')) {
    throw commandRejected(`${hostnameOf(ctx, toNodeId)} is not accepting work (${destInfo.availability}/${destInfo.status}).`);
  }
  const volumes = serviceVolumes(ctx, svc, fromNodeId);
  if (volumes.length === 0) throw commandRejected(`${svc.name} has no named volumes to move.`);

  const manager = await resolveManagerNode(ctx);
  const moveId = newMoveId(deps.now());
  const secret = deps.secret();
  const state: MoveState = {
    id: moveId,
    step: 'serve',
    from: fromNodeId,
    to: toNodeId,
    volumes,
    replicas,
    startedAt: new Date(deps.now()).toISOString(),
  };
  const setState = async (step: MoveStep) => {
    state.step = step;
    await ctx.hub.dispatch(manager.id, 'service.updateLabels', {
      service: svc.name,
      add: { [MOVE_STATE_LABEL]: JSON.stringify(state) },
      removeKeys: [],
    });
  };
  const say = (step: MoveProgress['step'], message: string, extra: Partial<MoveProgress> = {}) =>
    progress({ moveId, step, message, ...extra });
  const from = { nodeId: fromNodeId, hostname: hostnameOf(ctx, fromNodeId) };
  const to = { nodeId: toNodeId, hostname: hostnameOf(ctx, toNodeId) };
  const originalSpec = await liveServiceSpec(ctx, manager.id, svc);
  const createdDest = new Set<string>();
  let stoppedAt: number | undefined;
  let startedOnDest = false;

  const cleanupServe = async () => {
    await ctx.hub.dispatch(manager.id, 'service.remove', { service: moverServiceName(moveId) }).catch(() => undefined);
    await ctx.hub.dispatch(manager.id, 'secret.remove', { name: moverSecretName(moveId) }).catch(() => undefined);
  };

  try {
    await setState('serve');
    say('serve', `Opening a private copy channel on ${from.hostname}.`);
    await ctx.hub.dispatch(manager.id, 'secret.create', {
      name: moverSecretName(moveId),
      dataB64: Buffer.from(secret).toString('base64'),
      labels: { 'swarmy.move.id': moveId },
    });
    await ctx.hub.dispatch(manager.id, 'service.deploy', { spec: serveSpec(moveId, volumes, srcSwarm), pullPolicy: 'missing' });

    const pass = async (final: boolean) => {
      for (const v of volumes) {
        const out = await runOnce(
          ctx,
          toNodeId,
          pullScript({ host: moverServiceName(moveId), volume: v, final, requireEmpty: !final && !createdDest.has(v), bwlimitKbps: input.bwlimitKbps }),
          { binds: [`${v}:${MOVER_DST}`], env: { RSYNC_PASSWORD: secret }, network: true, timeoutMs: COPY_TIMEOUT_MS },
        );
        const stats = parseRsyncStats(out.output);
        if (stats.destNotEmpty) {
          throw commandRejected(`${to.hostname} already has a volume named ${v} with data in it — swarmy will not overwrite it. Remove it there, or pick another server.`);
        }
        createdDest.add(v);
        if (out.exitCode !== 0 || stats.exit !== 0) {
          throw commandRejected(`copying ${v} failed (rsync exit ${stats.exit ?? out.exitCode}): ${out.output.slice(-300)}`);
        }
        say(final ? 'copy-final' : 'copy-live', `${final ? 'Copied the last changes of' : 'Copied'} ${v}.`, {
          volume: v,
          bytes: stats.transferredBytes,
        });
      }
    };

    await setState('copy-live');
    say('copy-live', `Copying ${volumes.length} volume${volumes.length === 1 ? '' : 's'} to ${to.hostname} while ${svc.name} keeps running.`);
    await pass(false);

    await setState('stop');
    say('stop', `Pausing ${svc.name} for the final copy.`);
    stoppedAt = deps.now();
    await ctx.hub.dispatch(manager.id, 'service.scale', { service: svc.name, replicas: 0 });
    await waitFor(deps, STOP_TIMEOUT_MS, () => nodesRunning(ctx, svc.name).length === 0, `${svc.name} to stop`);

    await setState('copy-final');
    await pass(true);

    await setState('verify');
    const manifests: MoveResult['volumes'] = [];
    for (const v of volumes) {
      const [a, b] = [await manifestOn(ctx, fromNodeId, v, input.checksum !== false), await manifestOn(ctx, toNodeId, v, input.checksum !== false)];
      const diff = compareManifests(a, b);
      if (diff) throw commandRejected(`the copy of ${v} does not match the original: ${diff}`);
      manifests.push({ name: v, manifest: b });
      say('verify', `${v} matches on both servers (${a.files} files).`, { volume: v, bytes: a.bytes });
    }

    await setState('repin');
    const moved = repinSpec(originalSpec, destSwarm, PINNED_DATA_LABELS);
    const now = deps.now();
    moved.labels = {
      ...(moved.labels ?? {}),
      [MOVE_STATE_LABEL]: JSON.stringify({ ...state, step: 'start' }),
      [MOVE_OLD_COPIES_LABEL]: addOldCopies(svc.labels[MOVE_OLD_COPIES_LABEL], volumes.map((v) => oldCopy(fromNodeId, v, now))),
    };
    moved.mode = { replicated: { replicas } };
    await ctx.hub.dispatch(manager.id, 'service.deploy', { spec: moved, pullPolicy: 'missing' });
    say('start', `Starting ${svc.name} on ${to.hostname}.`);
    await waitFor(deps, START_TIMEOUT_MS, () => nodesRunning(ctx, svc.name).includes(toNodeId), `${svc.name} to start on ${to.hostname}`);
    startedOnDest = true;
    const pausedSeconds = Math.round((deps.now() - (stoppedAt ?? deps.now())) / 1000);

    await ctx.hub.dispatch(manager.id, 'service.updateLabels', { service: svc.name, add: {}, removeKeys: [MOVE_STATE_LABEL] });
    await cleanupServe();
    say('done', `${svc.name} now runs on ${to.hostname}. The old copy stays on ${from.hostname}; you'll be asked about it in 7 days.`);
    await writeAudit(ctx, {
      action: 'volume.move',
      targetType: 'service',
      targetId: svc.name,
      metadata: { moveId, from: from.hostname, to: to.hostname, volumes, pausedSeconds },
    });
    return { moveId, service: svc.name, from, to, volumes: manifests, pausedSeconds };
  } catch (err) {
    if (!startedOnDest) {
      say('rollback', `Something went wrong — putting ${svc.name} back on ${from.hostname}.`);
      if (state.step === 'repin' || state.step === 'start') {
        const back = { ...originalSpec, mode: { replicated: { replicas } } } as ServiceSpec;
        await ctx.hub.dispatch(manager.id, 'service.deploy', { spec: back, pullPolicy: 'missing' }).catch(() => undefined);
      } else if (stoppedAt !== undefined) {
        await ctx.hub.dispatch(manager.id, 'service.scale', { service: svc.name, replicas }).catch(() => undefined);
      }
      await ctx.hub
        .dispatch(manager.id, 'service.updateLabels', { service: svc.name, add: {}, removeKeys: [MOVE_STATE_LABEL] })
        .catch(() => undefined);
      await cleanupServe();
      // Only copies THIS move created (a refused non-empty destination was never touched).
      for (const v of createdDest) {
        await ctx.hub.dispatch(toNodeId, 'volume.remove', { name: v, cluster: false }).catch(() => undefined);
      }
      await writeAudit(ctx, {
        action: 'volume.move.rolledBack',
        targetType: 'service',
        targetId: svc.name,
        metadata: { moveId, step: state.step, from: from.hostname, to: to.hostname, error: (err as Error).message },
      });
    }
    throw err;
  }
}

/**
 * A move interrupted by a controller restart (its state label survived):
 * put the service back where its data is. Before `repin` that is the source
 * (scale back); after, the destination is already declared — just clear.
 */
export async function recoverInterruptedMoves(ctx: Ctx): Promise<string[]> {
  const out: string[] = [];
  const manager = await resolveManagerNode(ctx).catch(() => null);
  if (!manager) return out;
  for (const svc of ctx.hub.liveInventory(ctx.activeOrgId).services) {
    const raw = svc.labels[MOVE_STATE_LABEL];
    if (!raw) continue;
    let state: MoveState | null = null;
    try {
      state = JSON.parse(raw) as MoveState;
    } catch {
      state = null;
    }
    if (state && !['repin', 'start', 'done'].includes(state.step)) {
      await ctx.hub.dispatch(manager.id, 'service.scale', { service: svc.name, replicas: state.replicas }).catch(() => undefined);
      await ctx.hub.dispatch(manager.id, 'service.remove', { service: moverServiceName(state.id) }).catch(() => undefined);
      await ctx.hub.dispatch(manager.id, 'secret.remove', { name: moverSecretName(state.id) }).catch(() => undefined);
    }
    await ctx.hub
      .dispatch(manager.id, 'service.updateLabels', { service: svc.name, add: {}, removeKeys: [MOVE_STATE_LABEL] })
      .catch(() => undefined);
    out.push(svc.name);
  }
  return out;
}

/** Delete an old copy the owner confirmed (never automatic). */
export async function deleteOldCopy(ctx: Ctx, input: { service: string; nodeId: string; volume: string }): Promise<void> {
  const svc = liveService(ctx, input.service);
  if (!svc) throw notFound('service', input.service);
  const copies = (() => {
    try {
      return JSON.parse(svc.labels[MOVE_OLD_COPIES_LABEL] ?? '[]') as { nodeId: string; volume: string }[];
    } catch {
      return [];
    }
  })();
  if (!copies.some((c) => c.nodeId === input.nodeId && c.volume === input.volume)) {
    throw commandRejected('that old copy is not recorded on this service.');
  }
  if (nodesRunning(ctx, svc.name).includes(input.nodeId)) {
    throw commandRejected(`${svc.name} runs on that server again — its volume there is live data, not an old copy.`);
  }
  await ctx.hub.dispatch(input.nodeId, 'volume.remove', { name: input.volume, cluster: false });
  const manager = await resolveManagerNode(ctx);
  const rest = copies.filter((c) => !(c.nodeId === input.nodeId && c.volume === input.volume));
  await ctx.hub.dispatch(manager.id, 'service.updateLabels', {
    service: svc.name,
    add: rest.length ? { [MOVE_OLD_COPIES_LABEL]: JSON.stringify(rest) } : {},
    removeKeys: rest.length ? [] : [MOVE_OLD_COPIES_LABEL],
  });
  await writeAudit(ctx, { action: 'volume.oldCopy.delete', targetType: 'service', targetId: svc.name, metadata: input });
}

// ── managed Postgres: planned switchover ─────────────────────────────────────

export interface SwitchoverDeps extends MoverDeps {
  /** psql -tAc inside a member's running task (resilience `execInService`). */
  psql(service: string, sql: string): Promise<string>;
  /** manageddb.setReplicas / setTopology (labels + scale). */
  setReplicas(stack: string, cluster: string, replicas: number): Promise<void>;
  setTopology(stack: string, cluster: string, topology: string): Promise<void>;
}

const SWITCHOVER_REPLICA_TIMEOUT_MS = 15 * 60_000;
const SWITCHOVER_PROMOTE_TIMEOUT_MS = 3 * 60_000;
/** Close enough to start the final freeze (the freeze itself waits for 0). */
const CATCH_UP_BYTES = 16 * 1024 * 1024;

function clusterMembers(ctx: Ctx, stack: string, cluster: string): SwarmServiceInfo[] {
  return ctx.hub
    .liveInventory(ctx.activeOrgId)
    .services.filter((s) => s.labels[STACK_LABEL] === stack && s.labels['swarmy.db.cluster'] === cluster);
}

/**
 * Move a managed Postgres cluster's WRITER off `avoidNodeId` with a planned
 * switchover. Pause for writers: from the freeze until the promotion (seconds).
 */
export async function switchoverDb(
  ctx: Ctx,
  input: { stack: string; cluster: string; avoidNodeId: string },
  deps: SwitchoverDeps,
  progress: ProgressFn = () => {},
): Promise<{ promoted: string; demoted: string; addedReplica: boolean }> {
  const moveId = newMoveId(deps.now());
  const say = (step: MoveProgress['step'], message: string) => progress({ moveId, step, message });
  const primaryOf = () =>
    clusterMembers(ctx, input.stack, input.cluster).find((s) => s.labels['swarmy.db.role'] === 'primary' && !s.labels['swarmy.db.member']);
  const primary = primaryOf();
  if (!primary) throw notFound('db cluster', input.cluster);
  const topology = primary.labels['swarmy.db.topology'] ?? 'primary-replica';
  if (topology === 'active-active') throw commandRejected('active-active writers are not moved automatically.');
  const avoidSwarm = ctx.hub.swarmNodeIdFor(input.avoidNodeId);
  const declared = Number(primary.labels['swarmy.db.replicas'] ?? '0') || 0;
  const manager = await resolveManagerNode(ctx);

  // 1. A replica running somewhere else.
  const replicaElsewhere = () =>
    clusterMembers(ctx, input.stack, input.cluster).find(
      (s) =>
        s.labels['swarmy.db.role'] === 'replica' &&
        (s.runningReplicas ?? 0) > 0 &&
        nodesRunning(ctx, s.name).some((n) => n !== input.avoidNodeId),
    );
  let addedReplica = false;
  if (!replicaElsewhere()) {
    say('serve', `Adding a copy of ${input.cluster} on another server first.`);
    if (topology === 'single') await deps.setTopology(input.stack, input.cluster, 'primary-replica');
    await deps.setReplicas(input.stack, input.cluster, Math.max(1, declared));
    addedReplica = true;
    await waitFor(deps, SWITCHOVER_REPLICA_TIMEOUT_MS, () => Boolean(replicaElsewhere()), 'the new copy to start');
  }
  const replica = replicaElsewhere()!;

  const lsnGap = async () => {
    const p = (await deps.psql(primary.name, 'SELECT pg_current_wal_flush_lsn()')).trim();
    const r = (await deps.psql(replica.name, 'SELECT pg_last_wal_replay_lsn()')).trim();
    return behindWatermarkBytes(p, r);
  };

  // 2. Catch up while writes continue.
  say('copy-live', `Waiting for the copy on ${hostnameOf(ctx, nodesRunning(ctx, replica.name)[0] ?? '')} to catch up.`);
  await (async () => {
    const deadline = deps.now() + SWITCHOVER_REPLICA_TIMEOUT_MS;
    for (;;) {
      const gap = await lsnGap().catch(() => null);
      if (gap !== null && gap <= CATCH_UP_BYTES) return;
      if (deps.now() > deadline) throw commandRejected('the copy did not catch up in time');
      await deps.sleep(POLL_MS);
    }
  })();

  // 3. Freeze writes, wait for 0 bytes behind.
  say('stop', 'Pausing writes for a few seconds.');
  const unfreeze = async () => {
    await deps.psql(primary.name, 'ALTER SYSTEM RESET default_transaction_read_only').catch(() => '');
    await deps.psql(primary.name, 'SELECT pg_reload_conf()').catch(() => '');
  };
  await deps.psql(primary.name, 'ALTER SYSTEM SET default_transaction_read_only = on');
  await deps.psql(primary.name, 'SELECT pg_reload_conf()');
  try {
    await deps.psql(primary.name, 'CHECKPOINT');
    const deadline = deps.now() + 60_000;
    for (;;) {
      const gap = await lsnGap().catch(() => null);
      if (gap === 0) break;
      if (deps.now() > deadline) throw commandRejected(`the copy is still ${gap ?? 'an unknown number of'} bytes behind — switchover cancelled, writes resumed`);
      await deps.sleep(500);
    }
  } catch (e) {
    await unfreeze();
    throw e;
  }
  // Writes stay frozen through the stop: the setting lives in the old
  // writer's PGDATA, which the rejoin moves aside before re-cloning. Only a
  // rollback (the old writer restarts as the writer) resets it.

  // 4. Stop the primary; manageddb-reconcile promotes via decideFailover.
  say('repin', 'Switching the writer.');
  await ctx.hub.dispatch(manager.id, 'service.updateLabels', {
    service: primary.name,
    add: { [DB_SWITCHOVER_LABEL]: new Date(deps.now()).toISOString() },
    removeKeys: [],
  });
  await ctx.hub.dispatch(manager.id, 'service.scale', { service: primary.name, replicas: 0 });
  try {
    await waitFor(
      deps,
      SWITCHOVER_PROMOTE_TIMEOUT_MS,
      () => liveService(ctx, replica.name)?.labels['swarmy.db.role'] === 'primary',
      `${replica.name} to be promoted`,
    );
  } catch (e) {
    // Not promoted (held or failed): bring the old writer back.
    await ctx.hub.dispatch(manager.id, 'service.updateLabels', { service: primary.name, add: {}, removeKeys: [DB_SWITCHOVER_LABEL] }).catch(() => undefined);
    await ctx.hub.dispatch(manager.id, 'service.scale', { service: primary.name, replicas: 1 }).catch(() => undefined);
    await waitFor(deps, START_TIMEOUT_MS, () => nodesRunning(ctx, primary.name).length > 0, `${primary.name} to restart`).catch(() => undefined);
    await unfreeze();
    throw e;
  }

  // 5. Un-pin the demoted ex-primary from the old server; it re-clones elsewhere.
  say('start', `${replica.name} is now the writer; moving the old writer's slot off ${hostnameOf(ctx, input.avoidNodeId)}.`);
  const demoted = liveService(ctx, primary.name);
  const newWriterSwarm = ctx.hub.swarmNodeIdFor(nodesRunning(ctx, replica.name)[0] ?? '');
  if (demoted) {
    const { rebuildDbMemberSpec } = await import('./manageddb.service');
    const labels = { ...demoted.labels };
    delete labels[DB_PIN_NODE_LABEL];
    delete labels[DB_SWITCHOVER_LABEL];
    if (newWriterSwarm) labels[DB_AVOID_NODE_LABEL] = newWriterSwarm;
    const keep = addedReplica ? declared : Math.max(1, declared);
    const spec = rebuildDbMemberSpec(demoted, labels, keep);
    if (avoidSwarm) {
      spec.placement = {
        ...(spec.placement ?? {}),
        constraints: [...(spec.placement?.constraints ?? []).filter((c) => c !== `node.id!=${avoidSwarm}`), `node.id!=${avoidSwarm}`],
      };
    }
    await ctx.hub.dispatch(manager.id, 'service.deploy', { spec, pullPolicy: 'missing' });
  }
  if (addedReplica) {
    // Restore what was declared: setReplicas scales the (now) replica — the ex-primary.
    await deps.setReplicas(input.stack, input.cluster, declared);
    if (topology === 'single') await deps.setTopology(input.stack, input.cluster, 'single');
  }
  await writeAudit(ctx, {
    action: 'db.switchover',
    targetType: 'dbCluster',
    targetId: `${input.stack}/${input.cluster}`,
    metadata: { promoted: replica.name, demoted: primary.name, off: hostnameOf(ctx, input.avoidNodeId), addedReplica },
  });
  say('done', `${input.cluster} now writes on ${hostnameOf(ctx, nodesRunning(ctx, replica.name)[0] ?? '')}.`);
  return { promoted: replica.name, demoted: primary.name, addedReplica };
}
