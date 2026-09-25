/**
 * PlatformUpgradeRun — one button, never rebuild a cluster
 * (plans/epic-platform-upgrades.md §2). The step engine is pure
 * (`platform-upgrade.plan.ts`); this module is the IO for each step:
 *
 *   preflight  verified release, min-upgrade-from, every node online, swarm
 *              quorum, disk headroom, a FRESH controller self-backup, and the
 *              release's images copied into the built-in registry (best-effort).
 *   controller `docker service update --image controller@digest
 *              --update-failure-action rollback` (docker CLI one-shot on a
 *              manager, detached). Swarm stops this process (stop-first: the
 *              DB volume is node-pinned); the NEW controller boots, the resume
 *              tick re-drives the run, and `controllerStepDecision` sees it is
 *              the target build. A new controller that never turns healthy is
 *              rolled back by Swarm itself → the step fails.
 *   agents     rolling, one node at a time: `nodes.upgradeAgent` (this — new —
 *              controller's agent release; container agents pinned to the
 *              manifest digest), gated on the reconnect reporting the build.
 *              Rollback: container agents go back to the previous digest.
 *   system     system services in dependency order (DNS → edges → registry →
 *              observability), each `docker service update` health-gated with
 *              Swarm auto-rollback; the step's own rollback reverts every
 *              service it already moved (`docker service rollback`).
 *   engines    registered migrations that are not rolling — today the Garage
 *              major (`engine-upgrade.service`: snapshot → brief pause → v2,
 *              rollback = restore on v1), polled until it settles.
 *   verify     every node back, every system service converged; the release
 *              becomes the cluster's current manifest; audited.
 *
 * Resumable: the run row carries per-step `data`; `resumePlatformUpgrades`
 * (the worker tick) re-drives any `running` run this process isn't driving.
 */
import { registryConfigs } from './apps.repo';
import type { RunOnceResult } from '@swarmy/core/protocol';
import {
  componentRef,
  manifestImages,
  parsePlatformManifest,
  upgradeBlockReason,
  type PlatformManifest,
} from '@swarmy/core/platform-manifest';
import { mirroredRefFor, systemImage } from '@swarmy/core/system-images';
import type { OrgContext } from '../context';
import { commandRejected, notFound } from '../errors';
import { agentRelease } from './agent-release.service';
import { writeAudit } from './audit.service';
import { runControllerBackup } from './controllerBackup.service';
import { engineUpgradeAvailable, getEngineUpgrade, startEngineUpgrade } from './engine-upgrade.service';
import { isSameAgentBuild, upgradeAgent } from './node.service';
import { invalidateEffectiveImages } from './platform-images';
import {
  PROCESS_STARTED_AT,
  controllerBuild,
  currentManifestOf,
  getConfigRow,
  getReleaseView,
  signedBytesOf,
  verifyRelease,
  type PlatformReleaseView,
} from './platform-release.service';
import {
  STEP_ORDER,
  controllerStepDecision,
  driveRun,
  newRunState,
  parseUpdateOutput,
  planSystemUpdates,
  retryRun,
  runProgress,
  serviceRollbackScript,
  serviceUpdateScript,
  updateLanded,
  type RunState,
  type StepContext,
  type StepHandlers,
  type StepState,
} from './platform-upgrade.plan';
import { decodeRegistryCreds } from './registry-auth';
import { canonicalRegistryHost } from './registryPolicy.service';
import { mirrorStateFrom, mirrorSystemImagesForOrg } from './system-images.service';
import { storageClusterRepo } from './storage-cluster.repo';

export const CONTROLLER_SERVICE = 'swarmy_controller';
const MIN_FREE_BYTES = 2 * 1024 ** 3;
const AGENT_TIMEOUT_MS = 6 * 60_000;
const ENGINE_TIMEOUT_MS = 45 * 60_000;

/** IO seams (tests inject fakes). */
export interface PlatformUpgradeDeps {
  controllerBackup: (ctx: OrgContext) => Promise<{ snapshotId: string }>;
  mirror: (ctx: OrgContext, m: PlatformManifest) => Promise<{ copied: string[]; failed: string[]; skipped?: string }>;
  upgradeAgent: (ctx: OrgContext, nodeId: string, image?: string) => Promise<unknown>;
  agentRelease: () => { version: string; commit?: string } | null;
  engine: {
    available: (ctx: OrgContext) => Promise<string | null>;
    start: (ctx: OrgContext) => Promise<{ id: string }>;
    read: (ctx: OrgContext) => Promise<{ id: string; status: string; error?: string; to: string; from: string } | null>;
  };
  audit: typeof writeAudit;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  processStartedAt: number;
  self: () => { version: string; commit: string };
  pollMs: number;
}

export const defaultDeps: PlatformUpgradeDeps = {
  controllerBackup: (ctx) => runControllerBackup(ctx),
  mirror: (ctx, m) => mirrorSystemImagesForOrg({ db: ctx.db, hub: ctx.hub, auth: ctx.auth }, ctx.activeOrgId, undefined, manifestImages(m)),
  upgradeAgent: (ctx, nodeId, image) => upgradeAgent(ctx, nodeId, image ? { image } : {}),
  agentRelease,
  engine: {
    available: async (ctx) => {
      const row = await storageClusterRepo.find(ctx, ctx.activeOrgId);
      return row?.enabled ? engineUpgradeAvailable(row.engineImage) : null;
    },
    start: (ctx) => startEngineUpgrade(ctx),
    read: async (ctx) => (await getEngineUpgrade(ctx)).run,
  },
  audit: writeAudit,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => new Date(),
  processStartedAt: PROCESS_STARTED_AT,
  self: () => controllerBuild(),
  pollMs: 5_000,
};

// ── run row ↔ state ──────────────────────────────────────────────────────────

type RunRow = NonNullable<Awaited<ReturnType<OrgContext['db']['platformUpgradeRun']['findFirst']>>>;

interface RunOptions {
  skipBackup?: boolean;
}

function stateOf(row: RunRow): RunState {
  return {
    status: row.status as RunState['status'],
    step: row.step as RunState['step'],
    steps: (row.steps as unknown as StepState[]) ?? [],
    error: row.error,
    log: (row.log as RunState['log']) ?? [],
  };
}

async function persist(ctx: OrgContext, id: string, run: RunState): Promise<void> {
  const finished = run.status !== 'running';
  await ctx.db.platformUpgradeRun.update({
    where: { id },
    data: {
      status: run.status,
      step: run.step,
      steps: run.steps as unknown as object,
      error: run.error ?? null,
      log: run.log as unknown as object,
      finishedAt: finished ? new Date() : null,
    },
  });
  invalidateEffectiveImages(ctx.activeOrgId);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function manager(ctx: OrgContext): string {
  const m = ctx.hub.managerNode(ctx.activeOrgId);
  if (!m) throw new Error('no swarm manager is connected');
  return m;
}

async function registryLogin(ctx: OrgContext): Promise<{ host?: string; env: Record<string, string> }> {
  const reg = await registryConfigs(ctx, ctx.activeOrgId).findFirst().catch(() => null);
  if (!reg?.enabled) return { env: {} };
  const creds = decodeRegistryCreds(reg.credentialsEnc);
  return {
    host: canonicalRegistryHost(reg.host),
    env: creds ? { SWARMY_REG_USER: creds.username, SWARMY_REG_PASS: creds.password } : {},
  };
}

/** The docker CLI one-shot (docker.sock bound) that drives `docker service update`. */
export function dockerCliPayload(script: string, env: Record<string, string>, timeoutMs: number) {
  return {
    image: systemImage('dockerCli').ref,
    entrypoint: ['/bin/sh', '-c'],
    cmd: [script],
    binds: ['/var/run/docker.sock:/var/run/docker.sock'],
    env,
    user: '0:0',
    timeoutMs,
  };
}

async function dockerCli(ctx: OrgContext, script: string, env: Record<string, string>, timeoutMs: number) {
  const res = await ctx.hub.dispatch<RunOnceResult>(manager(ctx), 'container.runOnce', dockerCliPayload(script, env, timeoutMs), {
    timeoutMs: timeoutMs + 30_000,
  });
  return { ...parseUpdateOutput(res.output ?? ''), output: res.output ?? '' };
}

/** Ref to roll a component to: the mirrored copy when trusted for the target digest, else upstream@digest. */
async function refResolver(ctx: OrgContext, m: PlatformManifest) {
  const images = manifestImages(m);
  const reg = await registryLogin(ctx);
  const state = mirrorStateFrom(ctx.hub.liveInventory(ctx.activeOrgId));
  return (key: string, c: { ref: string; image: string; digest?: string }) =>
    (reg.host ? mirroredRefFor(c.ref, reg.host, state.labels, state.registryNodeId, images) : null) ?? `${c.image}@${c.digest}`;
}

function dataOf<T extends object>(step: StepState): T {
  step.data ??= {};
  return step.data as T;
}

// ── service health baseline ─────────────────────────────────────────────────

type HealthService = { name: string; desiredReplicas?: number; runningReplicas: number };

/** PURE — swarmy's own services (and the controller) that run fewer replicas than desired. */
export function unhealthySystemServices(services: readonly HealthService[]): HealthService[] {
  return services.filter(
    (s) => (s.name.startsWith('swarmy-') || s.name === CONTROLLER_SERVICE) && s.desiredReplicas !== undefined && s.runningReplicas < s.desiredReplicas,
  );
}

/**
 * PURE — what Verify fails on. A service already broken at preflight (the
 * baseline) is not the upgrade's doing (QA-027): it's reported, not failed on.
 * Offline servers always count (preflight required them all online).
 */
export function verifyProblems(input: {
  offlineNodes: readonly string[];
  services: readonly HealthService[];
  baseline: readonly string[];
}): { problems: string[]; preexisting: string[] } {
  const before = new Set(input.baseline);
  const bad = unhealthySystemServices(input.services);
  return {
    problems: [
      ...input.offlineNodes.map((n) => `${n} offline`),
      ...bad.filter((s) => !before.has(s.name)).map((s) => `${s.name} ${s.runningReplicas}/${s.desiredReplicas}`),
    ],
    preexisting: bad.filter((s) => before.has(s.name)).map((s) => s.name),
  };
}

// ── steps ────────────────────────────────────────────────────────────────────

export function buildHandlers(ctx: OrgContext, row: RunRow, deps: PlatformUpgradeDeps): StepHandlers {
  const target = parsePlatformManifest(row.manifest);
  const from = parsePlatformManifest(row.fromManifest);
  const options = (row.options as RunOptions | null) ?? {};
  // Services already unhealthy at preflight (kept in the preflight step's data,
  // so a run resumed after the controller restart still has it).
  const preflightData = ((row.steps as unknown as StepState[] | null) ?? []).find((st) => st.key === 'preflight')?.data as
    | { unhealthyBefore?: string[] }
    | undefined;
  let unhealthyBefore: string[] = preflightData?.unhealthyBefore ?? [];

  const preflight = async (c: StepContext) => {
    const d = dataOf<{ backupSnapshotId?: string; mirrored?: boolean; unhealthyBefore?: string[] }>(c.step);
    if (!d.unhealthyBefore) {
      d.unhealthyBefore = unhealthySystemServices(ctx.hub.liveInventory(ctx.activeOrgId).services).map((s) => s.name);
      if (d.unhealthyBefore.length) c.note(`already unhealthy before the upgrade (Verify won't fail on these): ${d.unhealthyBefore.join(', ')}`);
    }
    unhealthyBefore = d.unhealthyBefore;
    // Re-verify the stored signed bytes (the raw string; legacy rows hold the object).
    const rel = verifyRelease(typeof row.manifest === 'string' ? row.manifest : target, row.signature);
    if (!rel.verified) throw new Error(`unverified release: ${rel.reason}`);
    const block = upgradeBlockReason(row.fromVersion, target);
    if (block) throw new Error(block);

    const nodes = await ctx.db.node.findMany({ where: { orgId: ctx.activeOrgId }, select: { id: true, name: true } });
    if (!nodes.length) throw new Error('this cluster has no servers');
    const offline = nodes.filter((n) => !ctx.hub.isOnline(n.id));
    if (offline.length) throw new Error(`server(s) offline: ${offline.map((n) => n.name).join(', ')} — bring them back (or remove them) first`);

    const managers = ctx.hub.nodeInventory(ctx.activeOrgId, true).filter((n) => n.role === 'manager');
    const reachable = managers.filter((n) => n.status === 'ready' && n.reachability !== 'unreachable');
    if (managers.length && reachable.length <= managers.length / 2) {
      throw new Error(`swarm quorum at risk: ${reachable.length} of ${managers.length} managers reachable`);
    }

    const low: string[] = [];
    for (const n of nodes) {
      const s = ctx.hub.latestNodeStats(n.id);
      if (s?.fsTotalBytes && s.fsUsedBytes != null && s.fsTotalBytes - s.fsUsedBytes < MIN_FREE_BYTES) low.push(n.name);
    }
    if (low.length) throw new Error(`less than 2 GiB free disk on: ${low.join(', ')} — images for the new release need room`);

    if (!d.backupSnapshotId) {
      if (options.skipBackup) {
        d.backupSnapshotId = 'skipped';
        c.note('controller backup skipped (the admin chose to upgrade without one)');
      } else {
        c.note('taking a fresh controller backup');
        await c.checkpoint();
        try {
          d.backupSnapshotId = (await deps.controllerBackup(ctx)).snapshotId;
        } catch (e) {
          throw new Error(
            `a fresh controller backup failed (${e instanceof Error ? e.message : String(e)}). ` +
              'Set one up in Settings → Controller backup, or start the upgrade without a backup.',
          );
        }
        c.note(`controller backup ${d.backupSnapshotId} taken`);
      }
      await c.checkpoint();
    }

    if (!d.mirrored) {
      const r = await deps.mirror(ctx, target).catch((e: unknown) => ({ copied: [], failed: [], skipped: e instanceof Error ? e.message : String(e) }));
      d.mirrored = true;
      c.note(
        r.skipped
          ? `images not pre-copied (${r.skipped}); nodes pull them from upstream`
          : `release images in the cluster registry: ${r.copied.length} copied${r.failed.length ? `, ${r.failed.length} failed (upstream fallback)` : ''}`,
      );
    }
    return {
      status: 'done' as const,
      detail: `${nodes.length} server(s) online, quorum ok, backup ${d.backupSnapshotId === 'skipped' ? 'skipped' : 'taken'}`,
    };
  };

  const controller = async (c: StepContext) => {
    const d = dataOf<{ dispatchedAt?: string; ref?: string }>(c.step);
    const svc = ctx.hub.liveInventory(ctx.activeOrgId).services.find((s) => s.name === CONTROLLER_SERVICE);
    const ref = componentRef(target, 'controller');
    const decision = controllerStepDecision({
      target: target.components.controller?.digest ?? null,
      liveImage: svc?.image,
      liveUpdateState: svc?.updateStatus,
      inventoryReady: ctx.hub.managerNode(ctx.activeOrgId) !== undefined,
      dispatchedAt: d.dispatchedAt,
      processStartedAt: deps.processStartedAt,
      now: deps.now().getTime(),
      selfCommit: deps.self().commit,
      targetCommit: target.commit,
      fromCommit: from.commit,
    });
    if (decision.action === 'skip' || decision.action === 'done') return { status: decision.action === 'skip' ? ('skipped' as const) : ('done' as const), detail: decision.detail };
    if (decision.action === 'wait') return { status: 'wait' as const, detail: decision.detail };
    if (decision.action === 'fail') throw new Error(decision.reason);
    // dispatch — persist FIRST: Swarm stops this process moments after it accepts the spec.
    d.dispatchedAt = deps.now().toISOString();
    d.ref = ref ?? undefined;
    c.note(`replacing the controller with ${ref} (it restarts itself, then resumes this run)`);
    await c.checkpoint();
    const reg = await registryLogin(ctx);
    const r = await dockerCli(ctx, serviceUpdateScript(CONTROLLER_SERVICE, ref!, { detach: true, monitor: '90s', login: reg.host }), reg.env, 3 * 60_000);
    if (r.rc !== 0) {
      d.dispatchedAt = undefined;
      throw new Error(`Swarm refused the controller update: ${r.output.trim().split('\n').slice(-3).join(' ')}`);
    }
    return { status: 'wait' as const, detail: 'Swarm is replacing the controller; the new one resumes this run' };
  };

  const agents = async (c: StepContext) => {
    const d = dataOf<{ nodes?: Record<string, 'done' | 'upgraded' | 'dispatched'>; packaging?: Record<string, string> }>(c.step);
    d.nodes ??= {};
    d.packaging ??= {};
    const release = deps.agentRelease();
    if (!release) return { status: 'skipped' as const, detail: 'this controller carries no agent release (binaries not built)' };
    const image = componentRef(target, 'agent') ?? undefined;
    const nodes = await ctx.db.node.findMany({ where: { orgId: ctx.activeOrgId }, select: { id: true, name: true }, orderBy: { createdAt: 'asc' } });
    let moved = 0;
    for (const n of nodes) {
      if (d.nodes[n.id] === 'done' || d.nodes[n.id] === 'upgraded') continue;
      const build = ctx.hub.agentBuildFor?.(n.id);
      if (build && isSameAgentBuild(build, release) && d.nodes[n.id] !== 'dispatched') {
        d.nodes[n.id] = 'done';
        continue;
      }
      if (d.nodes[n.id] !== 'dispatched') {
        if (!ctx.hub.isOnline(n.id)) throw new Error(`${n.name} went offline before its agent could be upgraded`);
        d.packaging[n.id] = build?.packaging ?? 'container';
        c.step.detail = `${n.name}: upgrading the agent`;
        await deps.upgradeAgent(ctx, n.id, image);
        d.nodes[n.id] = 'dispatched';
        c.note(`${n.name}: agent update sent`);
        await c.checkpoint();
      }
      const deadline = deps.now().getTime() + AGENT_TIMEOUT_MS;
      for (;;) {
        const b = ctx.hub.isOnline(n.id) ? ctx.hub.agentBuildFor?.(n.id) : undefined;
        if (b && isSameAgentBuild(b, release)) break;
        if (deps.now().getTime() > deadline) throw new Error(`${n.name}: the agent did not come back on ${release.version} within 6 minutes`);
        await deps.sleep(deps.pollMs);
      }
      d.nodes[n.id] = 'upgraded';
      moved++;
      c.note(`${n.name}: agent back on ${release.version}`);
      await c.checkpoint();
    }
    return { status: 'done' as const, detail: moved ? `${moved} agent(s) upgraded, one at a time` : 'every agent already on this build' };
  };

  const agentsRollback = async (c: StepContext) => {
    const d = dataOf<{ nodes?: Record<string, string>; packaging?: Record<string, string> }>(c.step);
    const prev = componentRef(from, 'agent');
    const touched = Object.entries(d.nodes ?? {}).filter(([, s]) => s === 'upgraded' || s === 'dispatched');
    if (!touched.length) return 'no agent was changed';
    if (!prev) return 'agents stay on the new build (the previous release has no agent digest to return to)';
    const back: string[] = [];
    for (const [id] of touched) {
      if ((d.packaging?.[id] ?? 'container') !== 'container' || !ctx.hub.isOnline(id)) continue;
      await ctx.hub
        .dispatch(id, 'agent.update', { targetVersion: from.version, strategy: 'docker-recreate', image: prev })
        .then(() => back.push(id))
        .catch(() => undefined);
    }
    return `${back.length} container agent(s) sent back to ${from.version}; host-binary agents keep the new (backward-compatible) build`;
  };

  const system = async (c: StepContext) => {
    const d = dataOf<{ updated?: string[]; pending?: Array<{ service: string; key: string; from: string; to: string }> }>(c.step);
    d.updated ??= [];
    const resolve = await refResolver(ctx, target);
    const live = ctx.hub.liveInventory(ctx.activeOrgId).services;
    d.pending = planSystemUpdates(live, target.components, resolve).filter((u) => !d.updated!.includes(u.service));
    if (!d.pending.length && !d.updated.length) return { status: 'done' as const, detail: 'every system service already runs this release' };
    const reg = await registryLogin(ctx);
    for (const u of d.pending) {
      c.step.detail = `${u.service}: rolling to ${u.to.split('@')[0]}`;
      await c.checkpoint();
      const r = await dockerCli(ctx, serviceUpdateScript(u.service, u.to, { login: reg.host }), reg.env, 15 * 60_000);
      if (!updateLanded(r)) {
        throw new Error(
          `${u.service} did not come up healthy on the new image (Swarm: ${r.state}); it was rolled back to its previous image`,
        );
      }
      d.updated = [...d.updated, u.service];
      c.note(`${u.service}: healthy on ${u.to}`);
      await c.checkpoint();
    }
    return { status: 'done' as const, detail: `${d.updated.length} system service(s) upgraded` };
  };

  const systemRollback = async (c: StepContext) => {
    const d = dataOf<{ updated?: string[] }>(c.step);
    const done: string[] = [];
    for (const svc of [...(d.updated ?? [])].reverse()) {
      const r = await dockerCli(ctx, serviceRollbackScript(svc), {}, 15 * 60_000).catch(() => ({ rc: -1, state: 'error', output: '' }));
      if (r.rc === 0) done.push(svc);
    }
    return done.length ? `restored the previous image on ${done.join(', ')}` : 'nothing else to restore';
  };

  const engines = async (c: StepContext) => {
    const d = dataOf<{ engineRunId?: string; to?: string }>(c.step);
    if (!d.engineRunId) {
      const to = await deps.engine.available(ctx);
      if (!to) return { status: 'skipped' as const, detail: 'no engine migration applies (object storage is current or off)' };
      c.note(`object storage: starting the Garage migration to ${to} (brief pause, snapshot first)`);
      const r = await deps.engine.start(ctx);
      d.engineRunId = r.id;
      d.to = to;
      await c.checkpoint();
    }
    const deadline = deps.now().getTime() + ENGINE_TIMEOUT_MS;
    for (;;) {
      const r = await deps.engine.read(ctx);
      if (!r || r.id !== d.engineRunId) throw new Error('the Garage engine upgrade run disappeared');
      c.step.detail = `object storage: ${r.status}`;
      if (r.status === 'done') return { status: 'done' as const, detail: `object storage on ${r.to}` };
      if (r.status === 'rolled-back') throw new Error(`the Garage upgrade was rolled back (${r.error ?? 'unknown'}); the store is back on ${r.from}`);
      if (r.status === 'failed') throw new Error(`the Garage upgrade failed: ${r.error ?? 'unknown'} — its metadata backup is intact on every member`);
      if (deps.now().getTime() > deadline) throw new Error('the Garage upgrade did not settle within 45 minutes');
      await deps.sleep(deps.pollMs * 2);
    }
  };

  const verify = async (c: StepContext) => {
    const nodes = await ctx.db.node.findMany({ where: { orgId: ctx.activeOrgId }, select: { id: true, name: true } });
    const deadline = deps.now().getTime() + 5 * 60_000;
    let problems: string[] = [];
    let preexisting: string[] = [];
    for (;;) {
      ({ problems, preexisting } = verifyProblems({
        offlineNodes: nodes.filter((n) => !ctx.hub.isOnline(n.id)).map((n) => n.name),
        services: ctx.hub.liveInventory(ctx.activeOrgId).services,
        baseline: unhealthyBefore,
      }));
      if (!problems.length) break;
      if (deps.now().getTime() > deadline) throw new Error(`the cluster did not settle: ${problems.join(', ')}`);
      await deps.sleep(deps.pollMs * 2);
    }
    await getConfigRow(ctx.db, ctx.activeOrgId);
    await ctx.db.platformConfig.update({ where: { orgId: ctx.activeOrgId }, data: { currentManifest: target as object } });
    invalidateEffectiveImages(ctx.activeOrgId);
    c.note(`the cluster runs ${target.version}`);
    if (preexisting.length) c.note(`still unhealthy, as before the upgrade: ${preexisting.join(', ')}`);
    return {
      status: 'done' as const,
      detail: `${nodes.length} server(s) online, system services converged${preexisting.length ? ` (${preexisting.length} were already unhealthy before the upgrade)` : ''}`,
    };
  };

  return {
    preflight: { run: preflight },
    controller: { run: controller },
    agents: { run: agents, rollback: agentsRollback },
    system: { run: system, rollback: systemRollback },
    engines: { run: engines },
    verify: { run: verify },
  };
}

// ── drive / resume ───────────────────────────────────────────────────────────

const driving = new Set<string>();

export async function drivePlatformUpgrade(ctx: OrgContext, runId: string, deps: PlatformUpgradeDeps = defaultDeps): Promise<void> {
  if (driving.has(ctx.activeOrgId)) return;
  driving.add(ctx.activeOrgId);
  try {
    const row = await ctx.db.platformUpgradeRun.findFirst({ where: { id: runId, orgId: ctx.activeOrgId } });
    if (!row || row.status !== 'running') return;
    const run = stateOf(row);
    const result = await driveRun(run, buildHandlers(ctx, row, deps), (r) => persist(ctx, row.id, r), deps.now);
    if (result === 'done' || result === 'failed') {
      await deps
        .audit(ctx, {
          action: `platform.upgrade.${result}`,
          targetType: 'platformUpgradeRun',
          targetId: row.id,
          actorType: 'system',
          metadata: { from: row.fromVersion, to: row.toVersion, step: run.step, error: run.error ?? null },
        })
        .catch(() => undefined);
    }
  } catch (e) {
    // A crash outside a step (DB blip): the run stays `running`; the next tick resumes it.
    console.warn('[platform-upgrade] drive failed:', e instanceof Error ? e.message : e);
  } finally {
    driving.delete(ctx.activeOrgId);
  }
}

/** Re-drive every persisted `running` run this process isn't driving (boot + tick). */
export async function resumePlatformUpgrades(
  ctxFor: (orgId: string) => OrgContext,
  db: OrgContext['db'],
  deps: PlatformUpgradeDeps = defaultDeps,
): Promise<number> {
  const rows = await db.platformUpgradeRun.findMany({ where: { status: 'running' }, select: { id: true, orgId: true } });
  let n = 0;
  for (const r of rows) {
    if (driving.has(r.orgId)) continue;
    n++;
    void drivePlatformUpgrade(ctxFor(r.orgId), r.id, deps);
  }
  return n;
}

// ── API ──────────────────────────────────────────────────────────────────────

export interface PlatformRunView {
  id: string;
  status: RunState['status'];
  step: RunState['step'];
  fromVersion: string;
  toVersion: string;
  trigger: string;
  actorId: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  progress: { done: number; total: number };
  steps: Array<{ key: string; status: string; detail: string | null; error: string | null; startedAt: string | null; finishedAt: string | null }>;
  log: Array<{ at: string; msg: string }>;
  options: RunOptions;
}

function runView(row: RunRow): PlatformRunView {
  const s = stateOf(row);
  return {
    id: row.id,
    status: s.status,
    step: s.step,
    fromVersion: row.fromVersion,
    toVersion: row.toVersion,
    trigger: row.trigger,
    actorId: row.actorId,
    error: row.error,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    progress: runProgress(s),
    steps: STEP_ORDER.map((key) => {
      const st = s.steps.find((x) => x.key === key);
      return {
        key,
        status: st?.status ?? 'pending',
        detail: st?.detail ?? null,
        error: st?.error ?? null,
        startedAt: st?.startedAt ?? null,
        finishedAt: st?.finishedAt ?? null,
      };
    }),
    log: s.log.slice(-60),
    options: (row.options as RunOptions | null) ?? {},
  };
}

export interface PlatformStatusView {
  release: PlatformReleaseView;
  run: PlatformRunView | null;
  history: Array<Omit<PlatformRunView, 'log' | 'steps'>>;
}

export async function getPlatformStatus(ctx: OrgContext): Promise<PlatformStatusView> {
  const [release, rows] = await Promise.all([
    getReleaseView(ctx),
    ctx.db.platformUpgradeRun.findMany({ where: { orgId: ctx.activeOrgId }, orderBy: { startedAt: 'desc' }, take: 25 }),
  ]);
  const latest = rows[0] ? runView(rows[0]) : null;
  return {
    release,
    run: latest,
    history: rows.map((r) => {
      const { log: _log, steps: _steps, ...rest } = runView(r);
      return rest;
    }),
  };
}

export async function getPlatformRun(ctx: OrgContext, id: string): Promise<PlatformRunView> {
  const row = await ctx.db.platformUpgradeRun.findFirst({ where: { id, orgId: ctx.activeOrgId } });
  if (!row) throw notFound('platform upgrade run', id);
  return runView(row);
}

/** Start an upgrade to the stored, verified release. Returns once persisted; steps run in the background. */
export async function startPlatformUpgrade(
  ctx: OrgContext,
  input: { skipBackup?: boolean; version?: string; trigger?: 'manual' | 'auto' } = {},
  deps: PlatformUpgradeDeps = defaultDeps,
): Promise<PlatformRunView> {
  const cfg = await getConfigRow(ctx.db, ctx.activeOrgId);
  const available = cfg.available as { manifest?: unknown; raw?: unknown; signature?: string } | null;
  const signed = signedBytesOf(available);
  if (!available || !signed) throw commandRejected('no release is available — check for updates first');
  // Verify the exact bytes that were signed, never a re-serialised parse (QA-070).
  const rel = verifyRelease(signed, available.signature ?? '');
  if (!rel.verified || !rel.manifest) throw commandRejected(`unverified release: ${rel.reason ?? 'signature check failed'} — Upgrade is disabled`);
  const target = rel.manifest;
  if (input.version && input.version !== target.version) {
    throw commandRejected(`the available release is ${target.version}, not ${input.version} — refresh and try again`);
  }
  const current = currentManifestOf(cfg);
  const block = upgradeBlockReason(current.version, target);
  if (block) throw commandRejected(block);
  const active = await ctx.db.platformUpgradeRun.findFirst({ where: { orgId: ctx.activeOrgId, status: 'running' }, select: { id: true } });
  if (active) throw commandRejected('a platform upgrade is already running');

  const state = newRunState();
  const row = await ctx.db.platformUpgradeRun.create({
    data: {
      orgId: ctx.activeOrgId,
      status: state.status,
      step: state.step,
      fromVersion: current.version,
      toVersion: target.version,
      trigger: input.trigger ?? 'manual',
      actorId: ctx.user?.id ?? null,
      // The raw signed manifest (a JSON string) when we have it, so every resume
      // re-verifies the signed bytes; readers go through parsePlatformManifest.
      manifest: typeof signed === 'string' ? signed : (target as object),
      signature: available.signature ?? '',
      fromManifest: current as object,
      steps: state.steps as unknown as object,
      options: { skipBackup: Boolean(input.skipBackup) },
      log: [],
    },
  });
  await deps.audit(ctx, {
    action: 'platform.upgrade.start',
    targetType: 'platformUpgradeRun',
    targetId: row.id,
    ...(input.trigger === 'auto' ? { actorType: 'system' as const } : {}),
    metadata: { from: current.version, to: target.version, trigger: input.trigger ?? 'manual', skipBackup: Boolean(input.skipBackup) },
  });
  void drivePlatformUpgrade(ctx, row.id, deps);
  return runView(row);
}

/** Resume a failed run from its failed step (work already done is kept). */
export async function retryPlatformUpgrade(ctx: OrgContext, id: string, deps: PlatformUpgradeDeps = defaultDeps): Promise<PlatformRunView> {
  const row = await ctx.db.platformUpgradeRun.findFirst({ where: { id, orgId: ctx.activeOrgId } });
  if (!row) throw notFound('platform upgrade run', id);
  const active = await ctx.db.platformUpgradeRun.findFirst({ where: { orgId: ctx.activeOrgId, status: 'running', NOT: { id } }, select: { id: true } });
  if (active) throw commandRejected('another platform upgrade is running');
  let run: RunState;
  try {
    run = retryRun(stateOf(row), deps.now);
  } catch (e) {
    throw commandRejected(e instanceof Error ? e.message : String(e));
  }
  await persist(ctx, id, run);
  await deps.audit(ctx, { action: 'platform.upgrade.retry', targetType: 'platformUpgradeRun', targetId: id, metadata: { step: run.step } });
  void drivePlatformUpgrade(ctx, id, deps);
  const fresh = await ctx.db.platformUpgradeRun.findFirst({ where: { id } });
  return runView(fresh ?? row);
}

/** Give up on a failed run (the cluster stays as the failed step left it — each step already rolled itself back). */
export async function cancelPlatformUpgrade(ctx: OrgContext, id: string, deps: PlatformUpgradeDeps = defaultDeps): Promise<PlatformRunView> {
  const row = await ctx.db.platformUpgradeRun.findFirst({ where: { id, orgId: ctx.activeOrgId } });
  if (!row) throw notFound('platform upgrade run', id);
  if (row.status !== 'failed') throw commandRejected(`only a failed run can be dismissed (this one is ${row.status})`);
  const updated = await ctx.db.platformUpgradeRun.update({ where: { id }, data: { status: 'cancelled', finishedAt: row.finishedAt ?? new Date() } });
  await deps.audit(ctx, { action: 'platform.upgrade.cancel', targetType: 'platformUpgradeRun', targetId: id, metadata: { step: row.step } });
  return runView(updated);
}

