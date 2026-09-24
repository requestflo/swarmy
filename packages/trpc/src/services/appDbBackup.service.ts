/**
 * Logical backups + one-click restore for compose/blueprint databases
 * ("app DBs": MySQL, MariaDB, MongoDB, Redis, Valkey — whatever
 * `detectDbServices` finds). The agent does the work (`appdb.*` commands, see
 * `@swarmy/core/protocol` appDb.ts); this module decides what to run where.
 *
 * Belt and braces, on purpose: the nightly crash-consistent VOLUME backup
 * stays. It is what `dr-reconcile` restores onto a survivor when a node dies
 * (it keys off volume `Snapshot` rows), and it covers anything a dump can't
 * (a DB whose credentials we can't resolve, files beside the DB). The logical
 * dump rides the same schedule and lands in the same restic repo — restic
 * dedups both — and is what the dashboard's "Restore" loads.
 *
 * Docker is the truth for what exists (live inventory); the restic catalog is
 * the truth for which dumps exist (`appdb:<stack>/<service>` tags); history is
 * one `appdb.backup` / `appdb.restore` audit row per run. No new model.
 */
import { backupTargets } from './backups.repo';
import type { Auth } from '@swarmy/auth';
import type { DB } from '@swarmy/db';
import { randomToken } from '@swarmy/core/crypto';
import {
  appDbHost,
  appDbMethod,
  appDbTags,
  copySuffix,
  isKvEngine,
  resolveAppDbCreds,
  type AppDbBackupResult,
  type AppDbCredResolution,
  type AppDbEngine,
  type AppDbRestoreMode,
  type AppDbRestoreResult,
  type AppDbVerifyResult,
  type ListSnapshotsResult,
  type SwarmServiceInfo,
} from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import type { AgentHub } from '../hub/types';
import { commandRejected, mapDispatchError, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { chooseAutoBackupTarget, detectDbServices } from './autoBackup';
import { auditRetentionOutcome, loadTarget, resticNetworkFor, toResticRepo, type BackupTargetRow } from './backups.service';
import { systemContext } from './cicd.service';
import { resolveManagerNode } from './dispatch.service';
import { resolveExecTarget } from './live-resolve';

export const APPDB_BACKUP_AUDIT_ACTION = 'appdb.backup';
export const APPDB_RESTORE_AUDIT_ACTION = 'appdb.restore';
const APPDB_ENGINES = new Set<string>(['mysql', 'mariadb', 'postgres', 'mongo', 'redis', 'valkey']);
const HOUR_MS = 3_600_000;
const SCALE_WAIT_MS = 120_000;
const POLL_MS = 2_000;
/** The drill restores at most this many app DBs into scratch servers per run. */
export const VERIFY_DRILL_MAX_DBS = 5;

// ── detection (pure over live Docker truth) ──────────────────────────────────

export interface AppDb {
  stack: string;
  /** Swarm service name (`wp_db`). */
  service: string;
  engine: AppDbEngine;
  image: string;
  volume: string;
  /** Where the task mounts the data volume (Redis/Valkey RDB lives under it). */
  dataMount: string | null;
  desiredReplicas: number;
  creds: AppDbCredResolution;
}

/** Compose DBs with a logical-dump path, plus how their credentials resolve. */
export function detectAppDbs(services: SwarmServiceInfo[]): AppDb[] {
  const out: AppDb[] = [];
  for (const d of detectDbServices(services)) {
    if (!APPDB_ENGINES.has(d.engine)) continue;
    const svc = services.find((s) => s.name === d.service);
    if (!svc) continue;
    const engine = d.engine as AppDbEngine;
    out.push({
      stack: d.stack,
      service: d.service,
      engine,
      image: svc.image,
      volume: d.volume,
      dataMount: (svc.mounts ?? []).find((m) => m.source === d.volume)?.target ?? null,
      desiredReplicas: svc.desiredReplicas ?? 1,
      creds: resolveAppDbCreds(engine, svc.env ?? []),
    });
  }
  return out;
}

export function liveAppDbs(ctx: OrgContext): AppDb[] {
  return detectAppDbs(ctx.hub.liveInventory(ctx.activeOrgId).services);
}

function requireAppDb(ctx: OrgContext, stack: string, service: string): AppDb {
  const db = liveAppDbs(ctx).find((d) => d.stack === stack && d.service === service);
  if (!db) throw notFound('database service', `${stack}/${service}`);
  return db;
}

// ── destination ──────────────────────────────────────────────────────────────

async function resolveTarget(ctx: OrgContext, explicit?: string): Promise<BackupTargetRow> {
  if (explicit) return loadTarget(ctx, explicit);
  const rows = (await backupTargets(ctx, ctx.activeOrgId).findMany({
    where: { orgId: ctx.activeOrgId },
  })) as unknown as BackupTargetRow[];
  const t = chooseAutoBackupTarget(rows);
  if (!t) throw commandRejected('no backup destination configured — add one on the Backups page');
  return t;
}

function kvPayload(db: AppDb): { dataVolume?: string; dataMount?: string } {
  return isKvEngine(db.engine) && db.dataMount ? { dataVolume: db.volume, dataMount: db.dataMount } : {};
}

function ref(db: Pick<AppDb, 'stack' | 'service'>): string {
  return `${db.stack}/${db.service}`;
}

// ── backup ───────────────────────────────────────────────────────────────────

export type AppDbBackupReason = 'scheduled' | 'manual' | 'pre-restore';

export interface AppDbBackupRunView {
  engine: AppDbEngine;
  snapshotId: string;
  sizeBytes: string;
  databases: string[];
  tool: string | null;
  appendonly: boolean | null;
}

export async function runAppDbBackup(
  ctx: OrgContext,
  input: {
    stack: string;
    service: string;
    targetId?: string;
    reason: AppDbBackupReason;
    retentionDays?: number;
  },
): Promise<AppDbBackupRunView> {
  const db = requireAppDb(ctx, input.stack, input.service);
  const audit = (metadata: Record<string, unknown>) =>
    writeAudit(ctx, {
      action: APPDB_BACKUP_AUDIT_ACTION,
      actorType: ctx.user ? 'user' : 'system',
      targetType: 'appDb',
      targetId: ref(db),
      metadata: { engine: db.engine, reason: input.reason, ...metadata },
    });
  if (!db.creds.ok) {
    throw commandRejected(
      `a logical backup of ${db.service} isn't possible: ${db.creds.reason} — its volume snapshot still covers it`,
    );
  }
  if (isKvEngine(db.engine) && !db.dataMount) {
    throw commandRejected(`${db.service} has no data volume mount to read the RDB from`);
  }
  const exec = resolveExecTarget(ctx, db.service);
  if (!exec) throw commandRejected(`${db.service} has no running task to dump from`);
  const target = await resolveTarget(ctx, input.targetId);

  try {
    const r = await ctx.hub.dispatch<AppDbBackupResult>(
      exec.nodeId,
      'appdb.backup',
      {
        jobId: randomToken('adb'),
        engine: db.engine,
        service: db.service,
        creds: db.creds.creds,
        ...kvPayload(db),
        repo: toResticRepo(target),
        network: resticNetworkFor(target.endpoint),
        host: appDbHost(db.stack, db.service),
        tags: appDbTags(ctx.activeOrgId, db.stack, db.service, db.engine, input.reason),
        ...(input.retentionDays != null ? { retentionDays: input.retentionDays } : {}),
      },
      { timeoutMs: 4 * HOUR_MS },
    );
    await audit({
      status: 'succeeded',
      snapshotId: r.snapshotId,
      sizeBytes: String(r.sizeBytes),
      databases: r.databases,
      tool: r.tool ?? null,
      targetId: target.id,
    });
    await auditRetentionOutcome(ctx, { targetType: 'appDb', targetId: ref(db) }, r.retention);
    return {
      engine: r.engine,
      snapshotId: r.snapshotId,
      sizeBytes: String(r.sizeBytes),
      databases: r.databases,
      tool: r.tool ?? null,
      appendonly: r.appendonly ?? null,
    };
  } catch (e) {
    await audit({ status: 'failed', targetId: target.id, error: e instanceof Error ? e.message : String(e) });
    throw mapDispatchError(e);
  }
}

/**
 * Scheduler hook: a volume schedule just ran for `volume`; if that volume is an
 * app DB's data volume with resolvable credentials, take the logical dump too
 * (same destination, same retention). Unresolvable credentials are not an
 * error — the coverage view already says "volume snapshot only".
 */
export async function runScheduledAppDbDump(
  deps: { db: DB; hub: AgentHub; auth: Auth },
  input: { orgId: string; volume: string; targetId: string; retentionDays: number | null },
): Promise<'dumped' | 'skipped' | 'failed'> {
  const ctx = systemContext(deps, input.orgId);
  let db: AppDb | undefined;
  try {
    db = liveAppDbs(ctx).find((d) => d.volume === input.volume);
  } catch {
    return 'skipped';
  }
  if (!db || !db.creds.ok) return 'skipped';
  try {
    await runAppDbBackup(ctx, {
      stack: db.stack,
      service: db.service,
      targetId: input.targetId,
      reason: 'scheduled',
      ...(input.retentionDays != null ? { retentionDays: input.retentionDays } : {}),
    });
    return 'dumped';
  } catch {
    return 'failed'; // audited by runAppDbBackup
  }
}

// ── list ─────────────────────────────────────────────────────────────────────

export interface AppDbSnapshotView {
  id: string;
  time: string;
  engine: AppDbEngine | null;
  reason: string | null;
}

export async function listAppDbBackups(
  ctx: OrgContext,
  input: { stack: string; service: string; targetId?: string },
): Promise<AppDbSnapshotView[]> {
  const target = await resolveTarget(ctx, input.targetId);
  const node = await resolveManagerNode(ctx);
  try {
    const res = await ctx.hub.dispatch<ListSnapshotsResult>(node.id, 'backup.list', {
      repo: toResticRepo(target),
      // One comma-joined value = AND in restic (never another org's DB of the same name).
      tags: [`org:${ctx.activeOrgId},appdb:${input.stack}/${input.service}`],
      network: resticNetworkFor(target.endpoint),
    });
    return res.snapshots
      .map((s) => {
        const engine = s.tags.find((t) => t.startsWith('engine:'))?.slice(7) ?? null;
        return {
          id: s.id,
          time: s.time,
          engine: engine && APPDB_ENGINES.has(engine) ? (engine as AppDbEngine) : null,
          reason: s.tags.find((t) => t.startsWith('reason:'))?.slice(7) ?? null,
        };
      })
      .sort((a, b) => b.time.localeCompare(a.time));
  } catch (e) {
    throw mapDispatchError(e);
  }
}

// ── restore ──────────────────────────────────────────────────────────────────

export interface AppDbRestoreInput {
  stack: string;
  service: string;
  snapshotId: string;
  mode: AppDbRestoreMode;
  /** In-place only: the service name typed back. */
  confirm?: string;
  targetId?: string;
}

export interface AppDbRestoreView {
  mode: AppDbRestoreMode;
  engine: AppDbEngine;
  databases: string[];
  volume: string | null;
  /** In-place: the safety dump taken first (restore it to undo). */
  safetySnapshotId: string | null;
}

/** Pure precondition check — throws before anything is touched. */
export function checkRestorePreconditions(
  db: Pick<AppDb, 'service' | 'engine' | 'creds' | 'dataMount'>,
  input: Pick<AppDbRestoreInput, 'mode' | 'confirm'>,
): void {
  if (input.mode === 'in-place' && (input.confirm ?? '').trim() !== db.service) {
    throw commandRejected(`type ${db.service} to confirm an in-place restore`);
  }
  const kv = isKvEngine(db.engine);
  if (kv && !db.dataMount) throw commandRejected(`${db.service} has no data volume mount`);
  // SQL/Mongo load through the live server's credentials; an in-place
  // restore of any engine takes a logical safety dump first.
  if ((!kv || input.mode === 'in-place') && !db.creds.ok) {
    throw commandRejected(
      `can't ${input.mode === 'in-place' ? 'take the pre-restore safety dump' : 'log into the server'}: ${db.creds.reason}`,
    );
  }
}

/** Volume name for a Redis/Valkey restore-as-a-copy. */
export function copyVolumeName(volume: string, suffix: string): string {
  return `${volume}-${suffix.replace(/_/g, '-')}`.slice(0, 200);
}

async function waitForNoTask(ctx: OrgContext, service: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!resolveExecTarget(ctx, service)) return;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw commandRejected(`${service} did not stop within ${Math.round(timeoutMs / 1000)}s`);
}

export async function restoreAppDb(ctx: OrgContext, input: AppDbRestoreInput): Promise<AppDbRestoreView> {
  const db = requireAppDb(ctx, input.stack, input.service);
  checkRestorePreconditions(db, input);
  const kv = isKvEngine(db.engine);
  const exec = resolveExecTarget(ctx, db.service);
  if (!exec) throw commandRejected(`${db.service} has no running task — start it before restoring`);
  const target = await resolveTarget(ctx, input.targetId);
  const suffix = copySuffix(new Date());

  // In place: a fresh logical dump first, or nothing happens.
  let safety: AppDbBackupRunView | null = null;
  if (input.mode === 'in-place') {
    try {
      safety = await runAppDbBackup(ctx, {
        stack: db.stack,
        service: db.service,
        targetId: target.id,
        reason: 'pre-restore',
      });
    } catch (e) {
      throw commandRejected(
        `the pre-restore safety dump failed, so nothing was changed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (kv && safety.appendonly) {
      throw commandRejected(
        `${db.service} runs with appendonly yes — on restart it would load the AOF and ignore the restored RDB. Restore as a copy instead.`,
      );
    }
  }

  const payload = {
    engine: db.engine,
    mode: input.mode,
    service: db.service,
    creds: db.creds.ok ? db.creds.creds : { scope: 'none' as const, user: [], password: [], database: [], authDb: [], port: 6379 },
    ...kvPayload(db),
    repo: toResticRepo(target),
    network: resticNetworkFor(target.endpoint),
    snapshotId: input.snapshotId,
    suffix,
    ...(kv && input.mode === 'copy' ? { copyVolume: copyVolumeName(db.volume, suffix) } : {}),
  };

  let result: AppDbRestoreResult;
  try {
    if (kv && input.mode === 'in-place') {
      // Never swap an RDB under a live server: stop it, place the file on the
      // node that holds the volume, start it again — even if the placement fails.
      const manager = await resolveManagerNode(ctx);
      await ctx.hub.dispatch(manager.id, 'service.scale', { service: db.service, replicas: 0 });
      try {
        await waitForNoTask(ctx, db.service, SCALE_WAIT_MS);
        result = await ctx.hub.dispatch<AppDbRestoreResult>(exec.nodeId, 'appdb.restore', payload, {
          timeoutMs: 4 * HOUR_MS,
        });
      } finally {
        await ctx.hub
          .dispatch(manager.id, 'service.scale', { service: db.service, replicas: Math.max(1, db.desiredReplicas) })
          .catch(() => undefined);
      }
    } else {
      result = await ctx.hub.dispatch<AppDbRestoreResult>(exec.nodeId, 'appdb.restore', payload, {
        timeoutMs: 4 * HOUR_MS,
      });
    }
  } catch (e) {
    await writeAudit(ctx, {
      action: APPDB_RESTORE_AUDIT_ACTION,
      actorType: ctx.user ? 'user' : 'system',
      targetType: 'appDb',
      targetId: ref(db),
      metadata: {
        status: 'failed',
        engine: db.engine,
        mode: input.mode,
        snapshotId: input.snapshotId,
        safetySnapshotId: safety?.snapshotId ?? null,
        error: e instanceof Error ? e.message : String(e),
      },
    });
    throw mapDispatchError(e);
  }
  await writeAudit(ctx, {
    action: APPDB_RESTORE_AUDIT_ACTION,
    actorType: ctx.user ? 'user' : 'system',
    targetType: 'appDb',
    targetId: ref(db),
    metadata: {
      status: 'succeeded',
      engine: db.engine,
      mode: input.mode,
      snapshotId: input.snapshotId,
      safetySnapshotId: safety?.snapshotId ?? null,
      databases: result.databases,
      volume: result.volume ?? null,
      targetId: target.id,
    },
  });
  return {
    mode: result.mode,
    engine: result.engine,
    databases: result.databases,
    volume: result.volume ?? null,
    safetySnapshotId: safety?.snapshotId ?? null,
  };
}

// ── coverage (the stack Backups tab) ─────────────────────────────────────────

export interface AppDbCoverage {
  /** `logical` = nightly dump + volume; `volume-only` = credentials unresolved. */
  mode: 'logical' | 'volume-only';
  method: string;
  /** Why it's volume-only, or a caveat about how it dumps. */
  note: string | null;
  lastAt: string | null;
  lastStatus: 'succeeded' | 'failed' | null;
  lastError: string | null;
  lastSnapshotId: string | null;
}

interface AuditRow {
  targetId: string | null;
  ts: Date;
  metadata: unknown;
}

/** Pure: fold the latest `appdb.backup` audit row into a coverage line. */
export function coverageFor(db: Pick<AppDb, 'engine' | 'creds'>, last: AuditRow | undefined): AppDbCoverage {
  const m = (last?.metadata ?? {}) as Record<string, unknown>;
  const status = m.status === 'succeeded' || m.status === 'failed' ? m.status : null;
  return {
    mode: db.creds.ok ? 'logical' : 'volume-only',
    method: appDbMethod(db.engine),
    note: db.creds.ok ? db.creds.note : `volume snapshot only — ${db.creds.reason}`,
    lastAt: status && last ? last.ts.toISOString() : null,
    lastStatus: status,
    lastError: status === 'failed' && typeof m.error === 'string' ? m.error : null,
    lastSnapshotId: status === 'succeeded' && typeof m.snapshotId === 'string' ? m.snapshotId : null,
  };
}

/** Coverage per `stack/service` for the given app DBs (latest audit row each). */
export async function appDbCoverage(ctx: OrgContext, dbs: AppDb[]): Promise<Map<string, AppDbCoverage>> {
  const out = new Map<string, AppDbCoverage>();
  if (dbs.length === 0) return out;
  let rows: AuditRow[] = [];
  try {
    rows = (await ctx.db.auditLog.findMany({
      where: {
        orgId: ctx.activeOrgId,
        action: APPDB_BACKUP_AUDIT_ACTION,
        targetId: { in: dbs.map(ref) },
      },
      orderBy: { ts: 'desc' },
      take: 200,
      select: { targetId: true, ts: true, metadata: true },
    })) as unknown as AuditRow[];
  } catch {
    rows = [];
  }
  for (const db of dbs) {
    const last = rows.find((r) => {
      const m = r.metadata as Record<string, unknown> | null;
      return r.targetId === ref(db) && (m?.status === 'succeeded' || m?.status === 'failed');
    });
    out.set(ref(db), coverageFor(db, last));
  }
  return out;
}

// ── backup-verify drill leg ──────────────────────────────────────────────────

export interface AppDbVerifyStep {
  name: string;
  run: () => Promise<AppDbVerifyResult>;
  detail: (r: AppDbVerifyResult) => string;
}

/**
 * Steps the backup-verify drill runs after `restic check`: for each app DB
 * (up to {@link VERIFY_DRILL_MAX_DBS}) with a dump on this destination, restore
 * the newest into a scratch container on a manager and run a sanity query.
 * Read-only for the app: the scratch server has no network and is removed.
 */
export async function appDbVerifySteps(ctx: OrgContext, targetId: string, stack?: string): Promise<AppDbVerifyStep[]> {
  const dbs = liveAppDbs(ctx)
    .filter((d) => !stack || d.stack === stack)
    .filter((d) => !isKvEngine(d.engine) || d.dataMount)
    .slice(0, VERIFY_DRILL_MAX_DBS);
  if (dbs.length === 0) return [];
  const target = await loadTarget(ctx, targetId);
  const steps: AppDbVerifyStep[] = [];
  for (const db of dbs) {
    let latest: AppDbSnapshotView | undefined;
    try {
      latest = (await listAppDbBackups(ctx, { stack: db.stack, service: db.service, targetId }))[0];
    } catch {
      latest = undefined;
    }
    if (!latest) continue;
    const noun = isKvEngine(db.engine) ? 'keys' : db.engine === 'mongo' ? 'collections' : 'tables';
    steps.push({
      name: `Restore ${db.service} dump ${latest.id.slice(0, 8)} into a scratch ${db.engine}`,
      run: async () => {
        const node = await resolveManagerNode(ctx);
        try {
          return await ctx.hub.dispatch<AppDbVerifyResult>(
            node.id,
            'appdb.verify',
            {
              engine: db.engine,
              image: db.image,
              repo: toResticRepo(target),
              network: resticNetworkFor(target.endpoint),
              snapshotId: latest!.id,
              ...(db.dataMount ? { dataMount: db.dataMount } : {}),
            },
            { timeoutMs: 2 * HOUR_MS },
          );
        } catch (e) {
          throw mapDispatchError(e);
        }
      },
      detail: (r) => `${r.objects} ${noun}${r.databases.length ? ` in ${r.databases.join(', ')}` : ''}`,
    });
  }
  return steps;
}
