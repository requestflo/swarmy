/**
 * DB-aware backup service (epic: data-plane, richer engines; slice A1).
 *
 * Sits above the volume-level `backups.service`: instead of snapshotting a raw
 * Docker volume, it drives logical (`pg_dump` / `pg_dumpall` / read-replica) and
 * physical (`wal-g` / `pgbackrest`) Postgres backups of a *managed cluster*
 * (the `swarmy.db.*`-labelled services owned by `manageddb.service`).
 *
 * Cluster connection details (host = service name, password + database from the
 * live service env) are read from Docker truth and ride the WS to the agent as a
 * one-shot `DbConnection`; the agent runs the chosen engine as a short-lived
 * sidecar attached to the cluster overlay network. Listing reuses the existing
 * restic catalog (`backup.list`) filtered by the cluster's tag.
 *
 * Recurring backups are pure Docker truth: the schedule lives in the
 * `swarmy.db.backup.schedule` JSON label on the cluster primary
 * (`{cron, engine, retentionDays, pitr}`), the last outcome in
 * `swarmy.db.backup.lastRun`, and `swarmy.db.backup.pitr` flags WAL archiving
 * for the manageddb reconcile (slice A2). `runDueDbBackups` scans live
 * inventory across orgs each tick and dispatches whatever is due.
 */
import type { Auth } from '@swarmy/auth';
import type { DB } from '@swarmy/db';
import { decryptSecret, randomToken } from '@swarmy/core/crypto';
import { buildInventory, type InvService } from '@swarmy/core';
import type {
  DbBackupOverviewRow,
  DbBackupRunStatus,
  DbBackupScheduleView,
  DbBackupSnapshotView,
  RunDbBackupInput,
  SetDbBackupScheduleInput,
} from '@swarmy/core';
import type {
  DbBackupResult,
  DbConnection,
  DbRestoreMode,
  DbRestoreResult,
  ListSnapshotsResult,
  ResticRepo,
  ResticSnapshotInfo,
} from '@swarmy/core/protocol';
import { DbBackupEngine, isPhysicalEngine } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import type { AgentHub } from '../hub/types';
import { commandRejected, mapDispatchError, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { systemContext } from './cicd.service';
import { resolveManagerNode } from './dispatch.service';
import {
  DB_CLUSTER_LABEL,
  DB_MEMBER_LABEL,
  DB_ROLE_LABEL,
  clusterNetworkName,
} from './manageddb.service';
import { cronNext, isCronDue, parseCron, type CronSpec } from './schedule';

const PG_PORT = 5432;
const DEFAULT_DATABASE = 'app';
const DEFAULT_USER = 'postgres';
const DAY_MS = 86_400_000;

// ── Docker-truth label scheme (`swarmy.db.backup.*`) ──────────────────────────

/** JSON schedule on the cluster primary: `{cron, engine, retentionDays, pitr}`. */
export const DB_BACKUP_SCHEDULE_LABEL = 'swarmy.db.backup.schedule';
/** JSON outcome of the most recent backup run (stamped after every run). */
export const DB_BACKUP_LAST_RUN_LABEL = 'swarmy.db.backup.lastRun';
/** Set to "true" when the schedule enables PITR — the manageddb reconcile (A2)
 *  keys WAL archiving off this flag. */
export const DB_BACKUP_PITR_LABEL = 'swarmy.db.backup.pitr';

/** Decoded `swarmy.db.backup.schedule` label. */
export interface DbBackupSchedule {
  cron: string;
  engine: DbBackupEngine;
  retentionDays: number;
  pitr: boolean;
  targetId?: string;
  dataVolume?: string;
}

/** Decoded `swarmy.db.backup.lastRun` label. */
export interface DbBackupLastRun {
  at: string;
  status: DbBackupRunStatus;
  engine: DbBackupEngine;
  snapshotId?: string;
  sizeBytes?: string;
  error?: string;
}

/** Parse the schedule label; malformed/foreign JSON degrades to null (no throw). */
export function parseScheduleLabel(raw: string | undefined | null): DbBackupSchedule | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<DbBackupSchedule>;
    if (typeof v.cron !== 'string' || v.cron.trim().length === 0) return null;
    const engine = DbBackupEngine.safeParse(v.engine);
    if (!engine.success) return null;
    const retention = Number(v.retentionDays);
    return {
      cron: v.cron.trim(),
      engine: engine.data,
      retentionDays:
        Number.isFinite(retention) && retention >= 1 ? Math.floor(retention) : 14,
      pitr: v.pitr === true,
      ...(typeof v.targetId === 'string' && v.targetId ? { targetId: v.targetId } : {}),
      ...(typeof v.dataVolume === 'string' && v.dataVolume ? { dataVolume: v.dataVolume } : {}),
    };
  } catch {
    return null;
  }
}

/** Encode a schedule for the label (stable field order). */
export function encodeScheduleLabel(s: DbBackupSchedule): string {
  return JSON.stringify({
    cron: s.cron,
    engine: s.engine,
    retentionDays: s.retentionDays,
    pitr: s.pitr,
    ...(s.targetId ? { targetId: s.targetId } : {}),
    ...(s.dataVolume ? { dataVolume: s.dataVolume } : {}),
  });
}

/** Parse the last-run label; malformed JSON degrades to null. */
export function parseLastRunLabel(raw: string | undefined | null): DbBackupLastRun | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<DbBackupLastRun>;
    if (typeof v.at !== 'string' || Number.isNaN(new Date(v.at).getTime())) return null;
    if (v.status !== 'succeeded' && v.status !== 'failed') return null;
    const engine = DbBackupEngine.safeParse(v.engine);
    if (!engine.success) return null;
    return {
      at: v.at,
      status: v.status,
      engine: engine.data,
      ...(typeof v.snapshotId === 'string' ? { snapshotId: v.snapshotId } : {}),
      ...(typeof v.sizeBytes === 'string' ? { sizeBytes: v.sizeBytes } : {}),
      ...(typeof v.error === 'string' ? { error: v.error } : {}),
    };
  } catch {
    return null;
  }
}

/** Project a restic snapshot into the dashboard view (engine read off its tags). */
export function snapshotView(snap: ResticSnapshotInfo): DbBackupSnapshotView {
  const engineTag = snap.tags.find((t) => t.startsWith('engine:'))?.slice('engine:'.length);
  const engine = DbBackupEngine.safeParse(engineTag);
  return {
    id: snap.id,
    time: snap.time,
    engine: engine.success ? engine.data : null,
    sizeBytes: snap.sizeBytes != null ? String(snap.sizeBytes) : null,
    tags: snap.tags,
  };
}

/** Restorable PITR span: retention-bounded, up to the last successful backup. */
export function pitrWindow(
  schedule: DbBackupSchedule | null,
  lastRun: DbBackupLastRun | null,
  now: Date,
): { from: string; to: string } | null {
  if (!schedule?.pitr) return null;
  if (!lastRun || lastRun.status !== 'succeeded') return null;
  const from = new Date(now.getTime() - schedule.retentionDays * DAY_MS);
  return { from: from.toISOString(), to: lastRun.at };
}

/** Compose the schedule view (next run derived from the cron, UTC). */
export function scheduleView(
  stack: string,
  cluster: string,
  schedule: DbBackupSchedule,
  lastRun: DbBackupLastRun | null,
  now: Date,
): DbBackupScheduleView {
  let nextRunAt: string | null = null;
  try {
    nextRunAt = cronNext(parseCron(schedule.cron), now)?.toISOString() ?? null;
  } catch {
    nextRunAt = null;
  }
  return {
    stack,
    cluster,
    cron: schedule.cron,
    engine: schedule.engine,
    retentionDays: schedule.retentionDays,
    pitr: schedule.pitr,
    targetId: schedule.targetId ?? null,
    dataVolume: schedule.dataVolume ?? null,
    lastRunAt: lastRun?.at ?? null,
    lastStatus: lastRun?.status ?? null,
    nextRunAt,
  };
}

// ── target → restic repo (mirrors backups.service; targets are org-scoped) ────

interface TargetRow {
  id: string;
  name: string;
  kind: string;
  endpoint: string | null;
  bucket: string;
  prefix: string | null;
  region: string | null;
  credentialRef: string | null;
  secretKeyRef: string | null;
  resticPasswordRef: string;
}

async function loadTarget(ctx: OrgContext, id: string): Promise<TargetRow> {
  const row = (await ctx.db.backupTarget.findFirst({
    where: { id, orgId: ctx.activeOrgId },
  })) as unknown as TargetRow | null;
  if (!row) throw notFound('backup target', id);
  return row;
}

/** input target → schedule target → the org's first enabled target. */
async function resolveTargetId(
  ctx: OrgContext,
  explicit: string | undefined,
  schedule: DbBackupSchedule | null,
): Promise<string> {
  if (explicit) return explicit;
  if (schedule?.targetId) return schedule.targetId;
  const first = await ctx.db.backupTarget.findFirst({
    where: { orgId: ctx.activeOrgId, enabled: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!first) {
    throw commandRejected('no backup destination configured — add one on the Backups page');
  }
  return first.id;
}

function repoUrl(row: TargetRow): string {
  const prefix = row.prefix ? `/${row.prefix.replace(/^\/+/, '')}` : '';
  if (row.kind === 'node' || row.kind === 'NODE') {
    return `${row.bucket.replace(/\/+$/, '')}${prefix}`;
  }
  const endpoint = (row.endpoint ?? '').replace(/\/+$/, '');
  return `s3:${endpoint}/${row.bucket}${prefix}`;
}

function toResticRepo(row: TargetRow): ResticRepo {
  return {
    kind: row.kind === 'node' || row.kind === 'NODE' ? 'node' : 's3',
    repo: repoUrl(row),
    password: decryptSecret(row.resticPasswordRef),
    endpoint: row.endpoint ?? undefined,
    region: row.region ?? undefined,
    accessKeyId: row.credentialRef ? decryptSecret(row.credentialRef) : undefined,
    secretAccessKey: row.secretKeyRef ? decryptSecret(row.secretKeyRef) : undefined,
  };
}

// ── cluster discovery (Docker truth, via the live hub inventory) ──────────────

function envRecord(s: InvService): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of s.env) {
    const i = kv.indexOf('=');
    out[i >= 0 ? kv.slice(0, i) : kv] = i >= 0 ? kv.slice(i + 1) : '';
  }
  return out;
}

/** Base (unregioned, member-1) primaries across the whole org — one per cluster. */
function clusterPrimaries(ctx: OrgContext): InvService[] {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  return buildInventory(services, containers).services.filter(
    (s) =>
      Boolean(s.labels[DB_CLUSTER_LABEL]) &&
      s.labels[DB_ROLE_LABEL] === 'primary' &&
      !s.labels[DB_MEMBER_LABEL],
  );
}

function findCluster(
  ctx: OrgContext,
  stack: string,
  cluster: string,
): { primary?: InvService; replica?: InvService } {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  const members = buildInventory(services, containers).services
    .filter((s) => s.stack === stack)
    .filter((s) => s.labels[DB_CLUSTER_LABEL] === cluster);
  return {
    primary: members.find(
      (s) => s.labels[DB_ROLE_LABEL] === 'primary' && !s.labels[DB_MEMBER_LABEL],
    ),
    replica: members.find((s) => s.labels[DB_ROLE_LABEL] === 'replica'),
  };
}

/** Build a one-shot DB connection from a live DB-role service. */
function connFrom(svc: InvService, database?: string): DbConnection {
  const env = envRecord(svc);
  return {
    host: svc.name,
    port: PG_PORT,
    user: DEFAULT_USER,
    password: env.POSTGRESQL_PASSWORD ?? '',
    database: (database ?? env.POSTGRESQL_DATABASE ?? DEFAULT_DATABASE) || DEFAULT_DATABASE,
  };
}

function dbTags(orgId: string, stack: string, cluster: string, engine: DbBackupEngine): string[] {
  return [`org:${orgId}`, `db:${stack}/${cluster}`, `engine:${engine}`];
}

/** Best-effort stamp of the run outcome onto the primary (overview truth). */
async function stampLastRun(
  ctx: OrgContext,
  primaryService: string,
  run: DbBackupLastRun,
): Promise<void> {
  try {
    const node = await resolveManagerNode(ctx);
    await ctx.hub.dispatch(node.id, 'service.updateLabels', {
      service: primaryService,
      add: { [DB_BACKUP_LAST_RUN_LABEL]: JSON.stringify(run) },
      removeKeys: [],
    });
  } catch {
    // best-effort: a failed stamp only delays the overview, never the backup.
  }
}

// ── backup ────────────────────────────────────────────────────────────────────

export interface BackupDbInput {
  stack: string;
  cluster: string;
  engine: DbBackupEngine;
  targetId: string;
  /** Restrict a logical backup to a single database (defaults to the cluster's). */
  database?: string;
  /** Physical engines: the primary's PGDATA volume to base-back-up. */
  dataVolume?: string;
}

export interface DbBackupRunView {
  engine: DbBackupEngine;
  snapshotId: string;
  sizeBytes: string;
  databases: string[];
}

export async function backupDb(ctx: OrgContext, input: BackupDbInput): Promise<DbBackupRunView> {
  const target = await loadTarget(ctx, input.targetId);
  const { primary, replica } = findCluster(ctx, input.stack, input.cluster);
  if (!primary) throw notFound('db cluster primary', input.cluster);

  // snapshot-from-replica runs the dump against a read-replica (zero primary load).
  const fromReplica = input.engine === 'snapshot-from-replica';
  if (fromReplica && !replica) {
    throw commandRejected('snapshot-from-replica needs at least one read replica');
  }
  const source = fromReplica ? replica! : primary;
  const conn = connFrom(source, input.database);
  if (isPhysicalEngine(input.engine) && !input.dataVolume) {
    throw commandRejected(`engine "${input.engine}" requires a PGDATA volume (dataVolume)`);
  }

  const node = await resolveManagerNode(ctx);
  try {
    const result = await ctx.hub.dispatch<DbBackupResult>(node.id, 'db.backup', {
      jobId: randomToken('dbk'),
      engine: input.engine,
      conn,
      repo: toResticRepo(target),
      tags: dbTags(ctx.activeOrgId, input.stack, input.cluster, input.engine),
      network: clusterNetworkName(input.stack, input.cluster),
      dataVolume: input.dataVolume,
    });
    await writeAudit(ctx, {
      action: 'db.backup',
      actorType: ctx.user ? 'user' : 'system',
      targetType: 'dbCluster',
      targetId: `${input.stack}/${input.cluster}`,
      metadata: {
        engine: input.engine,
        targetId: target.id,
        snapshotId: result.snapshotId,
        fromReplica,
      },
    });
    await stampLastRun(ctx, primary.name, {
      at: new Date().toISOString(),
      status: 'succeeded',
      engine: input.engine,
      snapshotId: result.snapshotId,
      sizeBytes: String(result.sizeBytes),
    });
    return {
      engine: result.engine,
      snapshotId: result.snapshotId,
      sizeBytes: String(result.sizeBytes),
      databases: result.databases,
    };
  } catch (e) {
    await stampLastRun(ctx, primary.name, {
      at: new Date().toISOString(),
      status: 'failed',
      engine: input.engine,
      error: e instanceof Error ? e.message : String(e),
    });
    throw mapDispatchError(e);
  }
}

/**
 * "Back up now" — the schedule-aware alias the dashboard calls. Omitted fields
 * default from the cluster's `swarmy.db.backup.schedule` label; the destination
 * falls back to the org's first enabled backup target.
 */
export async function runDbBackup(ctx: OrgContext, input: RunDbBackupInput): Promise<DbBackupRunView> {
  const { primary } = findCluster(ctx, input.stack, input.cluster);
  if (!primary) throw notFound('db cluster primary', input.cluster);
  const schedule = parseScheduleLabel(primary.labels[DB_BACKUP_SCHEDULE_LABEL]);
  const engine = input.engine ?? schedule?.engine ?? 'pg_dump';
  const targetId = await resolveTargetId(ctx, input.targetId, schedule);
  return backupDb(ctx, {
    stack: input.stack,
    cluster: input.cluster,
    engine,
    targetId,
    database: input.database,
    dataVolume: input.dataVolume ?? schedule?.dataVolume,
  });
}

// ── schedule (Docker truth: the `swarmy.db.backup.schedule` primary label) ────

export async function getDbBackupSchedule(
  ctx: OrgContext,
  input: { stack: string; cluster: string },
): Promise<DbBackupScheduleView | null> {
  const { primary } = findCluster(ctx, input.stack, input.cluster);
  if (!primary) throw notFound('db cluster primary', input.cluster);
  const schedule = parseScheduleLabel(primary.labels[DB_BACKUP_SCHEDULE_LABEL]);
  if (!schedule) return null;
  const lastRun = parseLastRunLabel(primary.labels[DB_BACKUP_LAST_RUN_LABEL]);
  return scheduleView(input.stack, input.cluster, schedule, lastRun, new Date());
}

export async function setDbBackupSchedule(
  ctx: OrgContext,
  input: SetDbBackupScheduleInput,
): Promise<DbBackupScheduleView | null> {
  const { primary } = findCluster(ctx, input.stack, input.cluster);
  if (!primary) throw notFound('db cluster primary', input.cluster);
  const node = await resolveManagerNode(ctx);

  if (!input.enabled) {
    try {
      await ctx.hub.dispatch(node.id, 'service.updateLabels', {
        service: primary.name,
        add: {},
        removeKeys: [DB_BACKUP_SCHEDULE_LABEL, DB_BACKUP_PITR_LABEL],
      });
    } catch (e) {
      throw mapDispatchError(e);
    }
    await writeAudit(ctx, {
      action: 'db.backup.schedule.clear',
      actorType: ctx.user ? 'user' : 'system',
      targetType: 'dbCluster',
      targetId: `${input.stack}/${input.cluster}`,
    });
    return null;
  }

  try {
    parseCron(input.cron);
  } catch (e) {
    throw commandRejected(
      `invalid cron "${input.cron}": ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (isPhysicalEngine(input.engine) && !input.dataVolume) {
    throw commandRejected(
      `engine "${input.engine}" needs the primary's PGDATA volume (dataVolume) to schedule`,
    );
  }
  if (input.targetId) await loadTarget(ctx, input.targetId); // org-scope check

  const schedule: DbBackupSchedule = {
    cron: input.cron,
    engine: input.engine,
    retentionDays: input.retentionDays,
    pitr: input.pitr,
    ...(input.targetId ? { targetId: input.targetId } : {}),
    ...(input.dataVolume ? { dataVolume: input.dataVolume } : {}),
  };
  try {
    await ctx.hub.dispatch(node.id, 'service.updateLabels', {
      service: primary.name,
      add: {
        [DB_BACKUP_SCHEDULE_LABEL]: encodeScheduleLabel(schedule),
        ...(schedule.pitr ? { [DB_BACKUP_PITR_LABEL]: 'true' } : {}),
      },
      removeKeys: schedule.pitr ? [] : [DB_BACKUP_PITR_LABEL],
    });
  } catch (e) {
    throw mapDispatchError(e);
  }
  await writeAudit(ctx, {
    action: 'db.backup.schedule.set',
    actorType: ctx.user ? 'user' : 'system',
    targetType: 'dbCluster',
    targetId: `${input.stack}/${input.cluster}`,
    metadata: {
      cron: schedule.cron,
      engine: schedule.engine,
      retentionDays: schedule.retentionDays,
      pitr: schedule.pitr,
      targetId: schedule.targetId ?? null,
    },
  });
  const lastRun = parseLastRunLabel(primary.labels[DB_BACKUP_LAST_RUN_LABEL]);
  return scheduleView(input.stack, input.cluster, schedule, lastRun, new Date());
}

// ── overview (org-wide coverage table — pure inventory + target names) ────────

export async function dbBackupOverview(ctx: OrgContext): Promise<DbBackupOverviewRow[]> {
  const primaries = clusterPrimaries(ctx);
  if (primaries.length === 0) return [];
  const targets = await ctx.db.backupTarget.findMany({
    where: { orgId: ctx.activeOrgId },
    select: { id: true, name: true },
  });
  const targetName = new Map(targets.map((t) => [t.id, t.name]));
  const now = new Date();

  return primaries
    .map((p): DbBackupOverviewRow => {
      const schedule = parseScheduleLabel(p.labels[DB_BACKUP_SCHEDULE_LABEL]);
      const lastRun = parseLastRunLabel(p.labels[DB_BACKUP_LAST_RUN_LABEL]);
      let nextRunAt: string | null = null;
      if (schedule) {
        try {
          nextRunAt = cronNext(parseCron(schedule.cron), now)?.toISOString() ?? null;
        } catch {
          nextRunAt = null;
        }
      }
      const targetId = schedule?.targetId ?? null;
      return {
        stack: p.stack,
        cluster: p.labels[DB_CLUSTER_LABEL] ?? '',
        scheduled: schedule != null,
        cron: schedule?.cron ?? null,
        engine: schedule?.engine ?? lastRun?.engine ?? null,
        retentionDays: schedule?.retentionDays ?? null,
        pitr: schedule?.pitr ?? false,
        targetId,
        targetName: targetId ? (targetName.get(targetId) ?? null) : null,
        lastBackupAt: lastRun?.at ?? null,
        lastStatus: lastRun?.status ?? null,
        lastSizeBytes: lastRun?.sizeBytes ?? null,
        nextRunAt,
        pitrWindow: pitrWindow(schedule, lastRun, now),
      };
    })
    .sort((a, b) => `${a.stack}/${a.cluster}`.localeCompare(`${b.stack}/${b.cluster}`));
}

// ── list ────────────────────────────────────────────────────────────────────

export async function listDbBackups(
  ctx: OrgContext,
  input: { targetId?: string; stack?: string; cluster?: string },
): Promise<DbBackupSnapshotView[]> {
  let schedule: DbBackupSchedule | null = null;
  if (!input.targetId && input.stack && input.cluster) {
    const { primary } = findCluster(ctx, input.stack, input.cluster);
    schedule = parseScheduleLabel(primary?.labels[DB_BACKUP_SCHEDULE_LABEL]);
  }
  const target = await loadTarget(ctx, await resolveTargetId(ctx, input.targetId, schedule));
  const node = await resolveManagerNode(ctx);
  const tags =
    input.stack && input.cluster
      ? [`db:${input.stack}/${input.cluster}`]
      : [`org:${ctx.activeOrgId}`];
  try {
    const res = await ctx.hub.dispatch<ListSnapshotsResult>(node.id, 'backup.list', {
      repo: toResticRepo(target),
      tags,
    });
    return res.snapshots
      .map(snapshotView)
      .sort((a, b) => b.time.localeCompare(a.time));
  } catch (e) {
    throw mapDispatchError(e);
  }
}

// ── restore ───────────────────────────────────────────────────────────────────

export interface RestoreDbInput {
  stack: string;
  cluster: string;
  engine: DbBackupEngine;
  mode: DbRestoreMode;
  /** Defaults from the schedule label / the org's first enabled target. */
  targetId?: string;
  /** restic snapshot id (logical) / physical backup name; defaults to latest. */
  snapshotId?: string;
  /** pitr: ISO-8601 recovery target time. */
  targetTime?: string;
  /** single-database / target-db override. */
  database?: string;
  /** clone-to-new-cluster: where to restore into (defaults to the source cluster). */
  targetStack?: string;
  targetCluster?: string;
  /** pitr: the target PGDATA volume to recover into. */
  dataVolume?: string;
}

export interface DbRestoreRunView {
  mode: DbRestoreMode;
  engine: DbBackupEngine;
  database?: string;
  bytesRestored: string;
  recoveredTo?: string;
}

export async function restoreDb(ctx: OrgContext, input: RestoreDbInput): Promise<DbRestoreRunView> {
  const destStack = input.targetStack ?? input.stack;
  const destCluster = input.targetCluster ?? input.cluster;
  const { primary } = findCluster(ctx, destStack, destCluster);
  if (!primary) throw notFound('db cluster primary', destCluster);
  if (input.mode === 'pitr' && !input.dataVolume) {
    throw commandRejected('pitr restore requires the target PGDATA volume (dataVolume)');
  }
  const source = findCluster(ctx, input.stack, input.cluster).primary;
  const schedule = parseScheduleLabel(source?.labels[DB_BACKUP_SCHEDULE_LABEL]);
  const target = await loadTarget(ctx, await resolveTargetId(ctx, input.targetId, schedule));

  const conn = connFrom(primary, input.database);
  const node = await resolveManagerNode(ctx);
  try {
    const result = await ctx.hub.dispatch<DbRestoreResult>(node.id, 'db.restore', {
      engine: input.engine,
      mode: input.mode,
      conn,
      repo: toResticRepo(target),
      snapshotId: input.snapshotId ?? 'latest',
      targetTime: input.targetTime,
      database: input.database,
      tags: dbTags(ctx.activeOrgId, destStack, destCluster, input.engine),
      network: clusterNetworkName(destStack, destCluster),
      dataVolume: input.dataVolume,
    });
    await writeAudit(ctx, {
      action: 'db.restore',
      actorType: ctx.user ? 'user' : 'system',
      targetType: 'dbCluster',
      targetId: `${destStack}/${destCluster}`,
      metadata: {
        engine: input.engine,
        mode: input.mode,
        targetId: target.id,
        recoveredTo: result.recoveredTo ?? null,
      },
    });
    return {
      mode: result.mode,
      engine: result.engine,
      database: result.database,
      bytesRestored: String(result.bytesRestored),
      recoveredTo: result.recoveredTo,
    };
  } catch (e) {
    throw mapDispatchError(e);
  }
}

// ── scheduler tick (called from the manageddb reconcile worker, slice A2) ─────

export interface RunDueDbBackupsDeps {
  db: DB;
  hub: AgentHub;
  auth: Auth;
}

/**
 * Run any due scheduled DB backups: scan the live inventory of every org for
 * cluster primaries carrying `swarmy.db.backup.schedule`, compute cron due-ness
 * against the `swarmy.db.backup.lastRun` stamp, and dispatch `db.backup` for
 * whatever is due. Failures are stamped into the lastRun label (so the overview
 * shows them and the run is not hot-retried before the next cron slot).
 *
 * The spine-era call shape `runDueDbBackups(now)` stays compilable: without
 * `deps` (db + hub + auth) there is nothing to scan with, so it no-ops.
 */
export async function runDueDbBackups(now: Date, deps?: RunDueDbBackupsDeps): Promise<void> {
  if (!deps) return;
  const orgs = await deps.db.organization.findMany({ select: { id: true } });
  for (const org of orgs) {
    // No connected manager → nothing to read or dispatch for this org.
    if (!deps.hub.managerNode(org.id)) continue;
    const ctx = systemContext(deps, org.id);
    for (const primary of clusterPrimaries(ctx)) {
      const schedule = parseScheduleLabel(primary.labels[DB_BACKUP_SCHEDULE_LABEL]);
      if (!schedule) continue;
      let spec: CronSpec;
      try {
        spec = parseCron(schedule.cron);
      } catch {
        continue; // unparseable cron: surfaced as nextRunAt=null in the UI
      }
      const lastRun = parseLastRunLabel(primary.labels[DB_BACKUP_LAST_RUN_LABEL]);
      const lastAt = lastRun ? new Date(lastRun.at) : null;
      if (!isCronDue(spec, lastAt && !Number.isNaN(lastAt.getTime()) ? lastAt : null, now)) {
        continue;
      }
      const stack = primary.stack;
      const cluster = primary.labels[DB_CLUSTER_LABEL];
      if (!cluster) continue;
      try {
        const targetId = await resolveTargetId(ctx, undefined, schedule);
        await backupDb(ctx, {
          stack,
          cluster,
          engine: schedule.engine,
          targetId,
          dataVolume: schedule.dataVolume,
        });
      } catch (e) {
        // backupDb stamps dispatch failures itself; stamp pre-dispatch failures
        // (e.g. no destination) too so the schedule is not hot-retried each tick.
        await stampLastRun(ctx, primary.name, {
          at: now.toISOString(),
          status: 'failed',
          engine: schedule.engine,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
}
