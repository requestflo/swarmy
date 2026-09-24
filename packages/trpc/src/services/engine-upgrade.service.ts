/**
 * Object-storage engine upgrade — Garage v1 → v2, in place, no data loss.
 *
 * Garage majors are NOT rolling upgrades: every member stops, then starts on
 * the new binary together, and v2 migrates the metadata on first start. So:
 *
 *   preflight → stop → backup → deploy → verify → done
 *                 └──────── any failure ────────→ rollback (restore + v1)
 *
 *   preflight  every member online, cluster healthy (v1 dialect), bucket +
 *              object counts recorded for the verify step.
 *   stop       remove the swarmy-garage service; wait for every member task
 *              to exit. Object storage is unavailable from here (~1–2 min).
 *   backup     per member, a one-shot container cold-copies the metadata
 *              volume (quiescent: Garage is stopped, so the copy is exact).
 *   deploy     record the new engine on the row, redeploy (same volumes,
 *              config, secrets) — v2 migrates the metadata on start.
 *   verify     v2 reports healthy, every member connected, same buckets,
 *              same object counts.
 *   rollback   remove, restore each member's metadata copy, redeploy on the
 *              previous image — the store is exactly as it was.
 *
 * Every step is idempotent and the run is persisted on
 * `StorageCluster.engineUpgrade`, so a controller restart resumes it (see
 * `resumeEngineUpgrades`). While a run is `running`, the storage reconcile
 * stands down — it must not "heal" a store that was stopped on purpose.
 *
 * This is the first registered platform migration (plans/epic-platform-upgrades.md);
 * the platform upgrade run will invoke it as one step.
 */
import type { RunOnceResult } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { CURL_IMAGE, garageAdminAs } from './buckets.service';
import { garageMajorOf, LEGACY_GARAGE_IMAGE, type GarageCall, type GarageMajor } from './garage-admin';
import { DEFAULT_GARAGE_IMAGE } from './garage-render';
import { enable } from './replicatedStore.service';

/** IO seams (tests inject fakes; production uses the real services). */
export interface EngineUpgradeDeps {
  admin: (ctx: OrgContext, major: GarageMajor, call: GarageCall) => Promise<string>;
  redeploy: (ctx: OrgContext) => Promise<unknown>;
  audit: typeof writeAudit;
  pollMs: number;
}

const defaultDeps: EngineUpgradeDeps = {
  admin: garageAdminAs,
  redeploy: enable,
  audit: writeAudit,
  pollMs: 3_000,
};

const SERVICE_NAME = 'swarmy-garage';
/** Node-local volume the agent mounts at /var/lib/garage/meta (see handlers/storage.ts). */
export const GARAGE_META_VOLUME = `${SERVICE_NAME}-meta`;

export type EngineUpgradeStep = 'preflight' | 'stop' | 'backup' | 'deploy' | 'verify' | 'done' | 'rollback';
export type EngineUpgradeStatus = 'running' | 'done' | 'failed' | 'rolled-back';

export interface EngineUpgradeRun {
  id: string;
  from: string;
  to: string;
  status: EngineUpgradeStatus;
  step: EngineUpgradeStep;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /** Per-run metadata backup volume (same name on every member). */
  backupVolume: string;
  /** Controller node ids of the members, captured at preflight. */
  members: string[];
  /** Members whose metadata copy completed. */
  backedUp: string[];
  /** Pre-upgrade counts, re-checked after (bucket id → object count). */
  objects: Record<string, number>;
  log: Array<{ at: string; msg: string }>;
}

export interface EngineUpgradeView {
  running: string;
  runningMajor: GarageMajor;
  available: string | null;
  /** Plain-words impact shown before the admin confirms. */
  impact: string;
  run: EngineUpgradeRun | null;
}

const STOP_TIMEOUT_MS = 120_000;
const HEALTHY_TIMEOUT_MS = 300_000;

/** Backup volume name for a run (Docker volume names: [a-zA-Z0-9][a-zA-Z0-9_.-]). Pure. */
export function backupVolumeFor(runId: string): string {
  return `${GARAGE_META_VOLUME}-backup-${runId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)}`;
}

/** The one-shot that copies `from` → `to` (both volumes), replacing `to`'s contents. Pure. */
export function copyVolumePayload(from: string, to: string) {
  return {
    image: CURL_IMAGE, // alpine + busybox: `cp -a` — staged on every member by preflight
    entrypoint: ['/bin/sh', '-c'],
    cmd: ['set -eu; rm -rf /dst/* /dst/.[!.]* 2>/dev/null || true; cp -a /src/. /dst/; echo copied $(du -s /dst | cut -f1)'],
    binds: [`${from}:/src:ro`, `${to}:/dst`],
    user: '0:0',
    pull: false,
    timeoutMs: 10 * 60_000,
  };
}

/**
 * The one-shot preflight runs on every member to stage the copy image BEFORE
 * the outage: pull it, then a no-op run proves it is local. The admin-API
 * one-shots only ever ran on one node, so the other members may never have
 * pulled it — and the copy itself must not depend on a registry mid-outage. Pure.
 */
export function stageCopyImagePayload() {
  return {
    image: CURL_IMAGE,
    entrypoint: ['/bin/sh', '-c'],
    cmd: ['true'],
    pull: true,
    timeoutMs: 5 * 60_000,
  };
}

/** Is the store due an engine upgrade? Pure. */
export function engineUpgradeAvailable(running: string | null | undefined, target = DEFAULT_GARAGE_IMAGE): string | null {
  const cur = running ?? LEGACY_GARAGE_IMAGE;
  return garageMajorOf(cur) < garageMajorOf(target) ? target : null;
}

function now(): string {
  return new Date().toISOString();
}

async function loadRow(ctx: OrgContext) {
  const row = await ctx.db.storageCluster.findUnique({ where: { orgId: ctx.activeOrgId } });
  if (!row) throw notFound('storage cluster', ctx.activeOrgId);
  return row;
}

async function save(ctx: OrgContext, run: EngineUpgradeRun): Promise<void> {
  await ctx.db.storageCluster.update({ where: { orgId: ctx.activeOrgId }, data: { engineUpgrade: run as object } });
}

function note(run: EngineUpgradeRun, msg: string): void {
  run.log = [...run.log, { at: now(), msg }].slice(-60);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function getEngineUpgrade(ctx: OrgContext): Promise<EngineUpgradeView> {
  const row = await loadRow(ctx);
  const running = row.engineImage ?? LEGACY_GARAGE_IMAGE;
  return {
    running,
    runningMajor: garageMajorOf(running),
    available: engineUpgradeAvailable(row.engineImage),
    impact:
      'Garage upgrades between major versions are not rolling: object storage is unavailable for about ' +
      'one to two minutes while every member restarts on the new version. Metadata is copied first; ' +
      'any failure restores it and restarts the previous version automatically. Edges keep serving ' +
      'cached certificates; backups and apps retry.',
    run: (row.engineUpgrade as EngineUpgradeRun | null) ?? null,
  };
}

/** Start an upgrade run (admin). Returns once it's persisted; the steps run in the background. */
export async function startEngineUpgrade(ctx: OrgContext, deps: EngineUpgradeDeps = defaultDeps): Promise<EngineUpgradeRun> {
  const row = await loadRow(ctx);
  if (!row.enabled) throw commandRejected('object storage is not enabled');
  const current = row.engineUpgrade as EngineUpgradeRun | null;
  if (current?.status === 'running') throw commandRejected('an engine upgrade is already running');
  const to = engineUpgradeAvailable(row.engineImage);
  if (!to) throw commandRejected(`the store already runs ${row.engineImage ?? LEGACY_GARAGE_IMAGE}`);
  const id = `eu${Date.now().toString(36)}`;
  const run: EngineUpgradeRun = {
    id,
    from: row.engineImage ?? LEGACY_GARAGE_IMAGE,
    to,
    status: 'running',
    step: 'preflight',
    startedAt: now(),
    backupVolume: backupVolumeFor(id),
    members: Array.isArray(row.memberNodeIds) ? (row.memberNodeIds as string[]) : [],
    backedUp: [],
    objects: {},
    log: [],
  };
  await save(ctx, run);
  await deps.audit(ctx, {
    action: 'storage.engineUpgrade.start',
    targetType: 'storageCluster',
    targetId: row.id,
    metadata: { from: run.from, to: run.to, runId: id },
  });
  void driveEngineUpgrade(ctx, run, deps);
  return run;
}

/** In-process runs (one per org) so a resume never races a live run. */
const driving = new Set<string>();

/** Resume any persisted `running` run this process isn't already driving (controller restart). */
export async function resumeEngineUpgrade(ctx: OrgContext, deps: EngineUpgradeDeps = defaultDeps): Promise<boolean> {
  if (driving.has(ctx.activeOrgId)) return false;
  const row = await ctx.db.storageCluster.findUnique({ where: { orgId: ctx.activeOrgId } }).catch(() => null);
  const run = row?.engineUpgrade as EngineUpgradeRun | null | undefined;
  if (!run || run.status !== 'running') return false;
  void driveEngineUpgrade(ctx, run, deps);
  return true;
}

async function driveEngineUpgrade(ctx: OrgContext, run: EngineUpgradeRun, deps: EngineUpgradeDeps): Promise<void> {
  if (driving.has(ctx.activeOrgId)) return;
  driving.add(ctx.activeOrgId);
  try {
    const fromMajor = garageMajorOf(run.from);
    const toMajor = garageMajorOf(run.to);
    try {
      if (run.step === 'preflight') {
        await preflight(ctx, run, fromMajor, deps);
        run.step = 'stop';
        await save(ctx, run);
      }
      if (run.step === 'stop') {
        await stopStore(ctx, run, deps);
        run.step = 'backup';
        await save(ctx, run);
      }
      if (run.step === 'backup') {
        await backupMembers(ctx, run);
        run.step = 'deploy';
        await save(ctx, run);
      }
      if (run.step === 'deploy') {
        await ctx.db.storageCluster.update({ where: { orgId: ctx.activeOrgId }, data: { engineImage: run.to } });
        note(run, `deploying ${run.to} on ${run.members.length} member(s)`);
        await deps.redeploy(ctx);
        run.step = 'verify';
        await save(ctx, run);
      }
      if (run.step === 'verify') {
        await verify(ctx, run, toMajor, deps);
        run.step = 'done';
        run.status = 'done';
        run.finishedAt = now();
        note(run, `done — the store runs ${run.to}`);
        await save(ctx, run);
        await deps.audit(ctx, {
          action: 'storage.engineUpgrade.done',
          targetType: 'storageCluster',
          targetId: ctx.activeOrgId,
          metadata: { from: run.from, to: run.to, runId: run.id },
        }).catch(() => undefined);
      }
      if (run.step === 'rollback') await rollback(ctx, run, run.error ?? 'resumed rollback', deps);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (run.step === 'preflight') {
        // Nothing was touched: just fail.
        run.status = 'failed';
        run.error = message;
        run.finishedAt = now();
        note(run, `preflight failed: ${message}`);
        await save(ctx, run);
        return;
      }
      await rollback(ctx, run, message, deps);
    }
  } finally {
    driving.delete(ctx.activeOrgId);
  }
}

async function preflight(ctx: OrgContext, run: EngineUpgradeRun, major: GarageMajor, deps: EngineUpgradeDeps): Promise<void> {
  if (run.members.length === 0) throw new Error('the store has no members');
  const offline = run.members.filter((id) => !ctx.hub.isOnline(id));
  if (offline.length) throw new Error(`member node(s) offline: ${offline.join(', ')} — bring them back first`);
  const health = JSON.parse(await deps.admin(ctx, major, { method: 'GET', path: '/health' })) as { status?: string };
  if (health.status !== 'healthy') throw new Error(`the store reports "${health.status ?? 'unknown'}" — it must be healthy to upgrade`);
  run.objects = await objectCounts(ctx, major, deps);
  for (const nodeId of run.members) {
    const res = await ctx.hub
      .dispatch<RunOnceResult>(nodeId, 'container.runOnce', stageCopyImagePayload(), { timeoutMs: 6 * 60_000 })
      .catch((e: unknown) => ({ exitCode: -1, output: e instanceof Error ? e.message : String(e) }));
    if (res.exitCode !== 0) {
      throw new Error(`could not stage ${CURL_IMAGE} on ${nodeId}: ${(res.output ?? '').slice(-200)}`);
    }
  }
  note(run, `preflight ok: ${run.members.length} member(s), ${Object.keys(run.objects).length} bucket(s)`);
}

async function objectCounts(ctx: OrgContext, major: GarageMajor, deps: EngineUpgradeDeps): Promise<Record<string, number>> {
  const list = JSON.parse(await deps.admin(ctx, major, { method: 'GET', path: '/bucket?list' })) as Array<{ id: string }>;
  const out: Record<string, number> = {};
  for (const b of list) {
    const info = JSON.parse(
      await deps.admin(ctx, major, { method: 'GET', path: `/bucket?id=${encodeURIComponent(b.id)}` }),
    ) as { objects?: number };
    out[b.id] = Number(info.objects ?? 0);
  }
  return out;
}

function managerOrThrow(ctx: OrgContext): string {
  const mgr = ctx.hub.managerNode(ctx.activeOrgId);
  if (!mgr) throw new Error('no manager node is connected');
  return mgr;
}

function storeTasksRunning(ctx: OrgContext): number {
  return ctx.hub.liveInventory(ctx.activeOrgId).containers.filter((c) =>
    (c.name ?? '').replace(/^\//, '').startsWith(`${SERVICE_NAME}.`),
  ).length;
}

async function stopStore(ctx: OrgContext, run: EngineUpgradeRun, deps: EngineUpgradeDeps): Promise<void> {
  note(run, 'stopping every member (object storage unavailable from now)');
  await save(ctx, run);
  await ctx.hub
    .dispatch(managerOrThrow(ctx), 'service.remove', { service: SERVICE_NAME })
    .catch((e: unknown) => {
      if (!/not found|no such/i.test(e instanceof Error ? e.message : String(e))) throw e;
    });
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (storeTasksRunning(ctx) > 0) {
    if (Date.now() > deadline) throw new Error('members did not stop within 2 minutes');
    await sleep(deps.pollMs);
  }
  note(run, 'all members stopped');
}

async function backupMembers(ctx: OrgContext, run: EngineUpgradeRun): Promise<void> {
  for (const nodeId of run.members) {
    if (run.backedUp.includes(nodeId)) continue;
    const res = await ctx.hub.dispatch<RunOnceResult>(nodeId, 'container.runOnce', copyVolumePayload(GARAGE_META_VOLUME, run.backupVolume), {
      timeoutMs: 11 * 60_000,
    });
    if (res.exitCode !== 0) throw new Error(`metadata backup failed on ${nodeId}: ${(res.output ?? '').slice(-200)}`);
    run.backedUp = [...run.backedUp, nodeId];
    note(run, `metadata copied on ${nodeId} (${(res.output ?? '').trim().split('\n').pop()})`);
    await save(ctx, run);
  }
}

async function verify(ctx: OrgContext, run: EngineUpgradeRun, major: GarageMajor, deps: EngineUpgradeDeps): Promise<void> {
  const deadline = Date.now() + HEALTHY_TIMEOUT_MS;
  let last = 'no answer';
  for (;;) {
    try {
      const h = JSON.parse(await deps.admin(ctx, major, { method: 'GET', path: '/health' })) as {
        status?: string;
        connectedNodes?: number;
      };
      last = `${h.status} (${h.connectedNodes ?? 0}/${run.members.length} connected)`;
      if (h.status === 'healthy' && (h.connectedNodes ?? 0) >= run.members.length) break;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    if (Date.now() > deadline) throw new Error(`the new version did not become healthy: ${last}`);
    await sleep(deps.pollMs * 2);
  }
  const after = await objectCounts(ctx, major, deps);
  const missing = Object.keys(run.objects).filter((id) => !(id in after));
  if (missing.length) throw new Error(`bucket(s) missing after the upgrade: ${missing.join(', ')}`);
  const short = Object.entries(run.objects).filter(([id, n]) => (after[id] ?? 0) < n);
  if (short.length) throw new Error(`object counts dropped after the upgrade: ${short.map(([id]) => id).join(', ')}`);
  note(run, `verified: healthy, ${Object.keys(after).length} bucket(s), object counts intact`);
}

async function rollback(ctx: OrgContext, run: EngineUpgradeRun, reason: string, deps: EngineUpgradeDeps): Promise<void> {
  run.step = 'rollback';
  run.error = reason;
  note(run, `rolling back: ${reason}`);
  await save(ctx, run);
  try {
    await ctx.hub.dispatch(managerOrThrow(ctx), 'service.remove', { service: SERVICE_NAME }).catch(() => undefined);
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (storeTasksRunning(ctx) > 0 && Date.now() < deadline) await sleep(deps.pollMs);
    // Restore only where a copy exists; a member never copied was never touched by v2.
    for (const nodeId of run.backedUp) {
      const res = await ctx.hub.dispatch<RunOnceResult>(nodeId, 'container.runOnce', copyVolumePayload(run.backupVolume, GARAGE_META_VOLUME), {
        timeoutMs: 11 * 60_000,
      });
      if (res.exitCode !== 0) throw new Error(`restore failed on ${nodeId}: ${(res.output ?? '').slice(-200)}`);
      note(run, `metadata restored on ${nodeId}`);
    }
    await ctx.db.storageCluster.update({
      where: { orgId: ctx.activeOrgId },
      data: { engineImage: run.from === LEGACY_GARAGE_IMAGE ? null : run.from },
    });
    await deps.redeploy(ctx);
    run.status = 'rolled-back';
    note(run, `rolled back to ${run.from}`);
  } catch (e) {
    run.status = 'failed';
    note(run, `ROLLBACK FAILED: ${e instanceof Error ? e.message : String(e)} — backup volume ${run.backupVolume} is intact on each member`);
  }
  run.finishedAt = now();
  await save(ctx, run);
  await deps.audit(ctx, {
    action: `storage.engineUpgrade.${run.status}`,
    targetType: 'storageCluster',
    targetId: ctx.activeOrgId,
    metadata: { from: run.from, to: run.to, runId: run.id, reason },
  }).catch(() => undefined);
}
