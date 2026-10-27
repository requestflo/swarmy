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
 *
 * "Also copy to": the schedule's `secondaryTargetId` gets a copy of each save
 * that stamps `.lastRun` (`dbBackupCopy.run.ts`; outcome in
 * `swarmy.db.backup.copy`, lag in `dbBackupCopy.view.ts`).
 */
import { backupTargets } from './backups.repo';
import type { Auth } from '@swarmy/auth';
import type { DB } from '@swarmy/db';
import { decryptSecret, randomToken } from '@swarmy/core/crypto';
import {
  DB_DATA_VOLUME_LABEL,
  DB_PASSWORD_SECRET_LABEL,
  DB_PIN_NODE_LABEL,
  PG_ENV,
  buildInventory,
  type InvService,
} from '@swarmy/core';
import type {
  DbBackupOverviewRow,
  DbBackupRunStatus,
  DbBackupScheduleView,
  DbBackupSnapshotView,
  DbPitrWindowView,
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
import { assertEngineOffered, engineImageFor } from './dbBackupEngines';
import { runPitrRestore } from './dbPitrRestore.service';
import { readWritesBeforeSave } from './dbWrites.service';
import { restoreProgress, type RestoreRun } from './restore-progress';
import { knownPitrWindow, pitrPreflight, pitrWindowView, readPitrWindow, rememberPitrWindow } from './dbPitrWindow.service';
import { PRE_RESTORE_REASON, ensureSafetyCopy, latestRestorable, overwritesSource } from './dbRestoreSafety.service';
import { auditRetentionOutcome, resticNetworkFor } from './backups.service';
import { systemContext } from './cicd.service';
import { resolveManagerNode } from './dispatch.service';
import {
  DB_CLUSTER_LABEL,
  DB_MEMBER_LABEL,
  DB_ROLE_LABEL,
  clusterNetworkName,
  readDbPassword,
} from './manageddb.service';
import { cronNext, isCronDue, parseCron, type CronSpec } from './schedule';
import { DB_BACKUP_COPY_LABEL, copyMethod } from './dbBackupCopy.label';
import { copyFields } from './dbBackupCopy.read';
import { copyAfterSave } from './dbBackupCopy.run';
import { walgCopy } from './dbWalgCopy.service';
import {
  AUTO_BACKUP_RETENTION_DAYS,
  DB_BACKUP_AUTO_LABEL,
  DB_BACKUP_AUTO_OFF,
  staggeredCron,
} from './autoBackup';

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
  /**
   * Created by swarmy's default-on DB backups (nightly pg_dump, keep 7), not a
   * user. A user saving a schedule drops this; clearing one stamps the
   * `swarmy.db.backup.auto=off` opt-out so it is never re-created.
   */
  auto?: boolean;
  /** "Also copy to": each save is copied here too (`dbBackupCopy.run.ts`). */
  secondaryTargetId?: string;
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
      ...(v.auto === true ? { auto: true } : {}),
      ...(typeof v.secondaryTargetId === 'string' && v.secondaryTargetId ? { secondaryTargetId: v.secondaryTargetId } : {}),
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
    ...(s.auto ? { auto: true } : {}),
    ...(s.secondaryTargetId ? { secondaryTargetId: s.secondaryTargetId } : {}),
  });
}

/**
 * The default-on schedule for a managed cluster: a nightly LOGICAL backup
 * (`pg_dump` — transaction-consistent, unlike a live volume copy) at the
 * cluster's staggered 02:00–04:59 UTC slot, kept 7 days, marked `auto`.
 */
export function autoDbSchedule(stack: string, cluster: string, targetId: string): DbBackupSchedule {
  return {
    cron: staggeredCron(`${stack}/${cluster}`),
    engine: 'pg_dump',
    retentionDays: AUTO_BACKUP_RETENTION_DAYS,
    pitr: false,
    targetId,
    auto: true,
  };
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
    reason: snap.tags.find((t) => t.startsWith('reason:'))?.slice('reason:'.length) || null,
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
    lastError: lastRun?.error ?? null,
    nextRunAt,
    auto: schedule.auto === true,
    secondaryTargetId: schedule.secondaryTargetId ?? null,
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

export async function loadTarget(ctx: OrgContext, id: string): Promise<TargetRow> {
  const row = (await backupTargets(ctx, ctx.activeOrgId).findFirst({
    where: { id, orgId: ctx.activeOrgId },
  })) as unknown as TargetRow | null;
  if (!row) throw notFound('backup target', id);
  return row;
}

/** input target → schedule target → the org's first enabled target. */
export async function resolveTargetId(
  ctx: OrgContext,
  explicit: string | undefined,
  schedule: DbBackupSchedule | null,
): Promise<string> {
  if (explicit) return explicit;
  if (schedule?.targetId) return schedule.targetId;
  const first = await backupTargets(ctx, ctx.activeOrgId).findFirst({
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
export function clusterPrimaries(ctx: OrgContext): InvService[] {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  return buildInventory(services, containers).services.filter(
    (s) =>
      Boolean(s.labels[DB_CLUSTER_LABEL]) &&
      s.labels[DB_ROLE_LABEL] === 'primary' &&
      !s.labels[DB_MEMBER_LABEL],
  );
}

export function findCluster(
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

/**
 * The PGDATA volume a physical engine should use: explicit input wins, else the
 * primary's declared `swarmy.db.dataVolume` (the persistent-layout volume,
 * `<stack>_<cluster>-primary-data`, mounted at `/var/lib/postgresql/data`).
 */
export function effectiveDataVolume(
  explicit: string | undefined,
  primaryLabels: Record<string, string> | undefined,
): string | undefined {
  return explicit || primaryLabels?.[DB_DATA_VOLUME_LABEL] || undefined;
}

/**
 * Where a physical (volume-reading) engine must run: the node the primary is
 * pinned to (`swarmy.db.node`), because the data volume is node-local. Falls
 * back to a manager when unpinned or that node is offline.
 */
async function physicalNode(ctx: OrgContext, primaryLabels: Record<string, string>): Promise<{ id: string }> {
  const pin = primaryLabels[DB_PIN_NODE_LABEL];
  if (pin) {
    const onNode = ctx.hub.onlineNodeIds().find((id) => ctx.hub.swarmNodeIdFor(id) === pin);
    if (onNode) return { id: onNode };
  }
  return resolveManagerNode(ctx);
}

/**
 * Build a one-shot DB connection from a live DB-role service. The password is
 * read just-in-time from the cluster's Docker secret (`readDbPassword`), rides
 * the authenticated WS, and becomes the sidecar's 0600 PGPASSFILE agent-side —
 * never a container env var.
 */
async function connFrom(ctx: OrgContext, stack: string, cluster: string, svc: InvService, database?: string): Promise<DbConnection> {
  const env = envRecord(svc);
  return {
    host: svc.name,
    port: PG_PORT,
    user: DEFAULT_USER,
    password: env.POSTGRES_PASSWORD || (await readDbPassword(ctx, stack, cluster)),
    database: (database ?? env.POSTGRES_DB ?? DEFAULT_DATABASE) || DEFAULT_DATABASE,
  };
}

function dbTags(orgId: string, stack: string, cluster: string, engine: DbBackupEngine, reason?: string): string[] {
  return [`org:${orgId}`, `db:${stack}/${cluster}`, `engine:${engine}`, ...(reason ? [`reason:${reason}`] : [])];
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
  /**
   * Retention window (days) enforced agent-side with `restic forget
   * --keep-within --prune` after a successful backup. Callers thread the
   * schedule label's `retentionDays` here; absent = keep forever.
   */
  retentionDays?: number;
  /**
   * `pre-restore`: the safety copy a restore takes first. Tagged
   * `reason:pre-restore` so it reads as such in the catalog, and it does not
   * stamp `swarmy.db.backup.lastRun` (that label is the schedule's outcome).
   */
  reason?: typeof PRE_RESTORE_REASON;
  /**
   * A copy of save `copyOf` into the schedule's second destination: it does
   * not stamp `.lastRun` or read write counters, and is audited
   * `db.backup.copy`.
   */
  copyOf?: string;
}

export interface DbBackupRunView {
  engine: DbBackupEngine;
  snapshotId: string;
  sizeBytes: string;
  databases: string[];
  /** The time stamped on `swarmy.db.backup.lastRun` for this save. */
  savedAt: string;
}

export async function backupDb(ctx: OrgContext, input: BackupDbInput): Promise<DbBackupRunView> {
  assertEngineOffered(input.engine);
  const target = await loadTarget(ctx, input.targetId);
  const { primary, replica } = findCluster(ctx, input.stack, input.cluster);
  if (!primary) throw notFound('db cluster primary', input.cluster);

  // snapshot-from-replica runs the dump against a read-replica (zero primary load).
  const fromReplica = input.engine === 'snapshot-from-replica';
  if (fromReplica && !replica) {
    throw commandRejected('snapshot-from-replica needs at least one read replica');
  }
  const source = fromReplica ? replica! : primary;
  const conn = await connFrom(ctx, input.stack, input.cluster, source, input.database);
  const physical = isPhysicalEngine(input.engine);
  const dataVolume = physical ? effectiveDataVolume(input.dataVolume, primary.labels) : input.dataVolume;
  if (physical && !dataVolume) {
    throw commandRejected(`engine "${input.engine}" requires a PGDATA volume (dataVolume)`);
  }

  const node = physical ? await physicalNode(ctx, primary.labels) : await resolveManagerNode(ctx);
  const stamp = (run: DbBackupLastRun) => (input.reason || input.copyOf ? Promise.resolve() : stampLastRun(ctx, primary.name, run));
  // The primary's write counters just before a logical save of the main database, kept on its
  // audit row so "rows written since" can be counted later (dbWrites.service). Never fails the save.
  const writes = physical || input.database || input.copyOf ? null : await readWritesBeforeSave(ctx, input.stack, input.cluster, primary.name);
  try {
    const result = await ctx.hub.dispatch<DbBackupResult>(node.id, 'db.backup', {
      jobId: randomToken('dbk'),
      engine: input.engine,
      conn,
      repo: toResticRepo(target),
      tags: dbTags(ctx.activeOrgId, input.stack, input.cluster, input.engine, input.reason),
      retentionDays: input.retentionDays,
      network: clusterNetworkName(input.stack, input.cluster),
      resticNetwork: resticNetworkFor(target.endpoint),
      dataVolume,
      ...engineImageFor(input.engine),
    });
    await writeAudit(ctx, {
      action: input.copyOf ? 'db.backup.copy' : 'db.backup',
      actorType: ctx.user ? 'user' : 'system',
      targetType: 'dbCluster',
      targetId: `${input.stack}/${input.cluster}`,
      metadata: {
        engine: input.engine,
        targetId: target.id,
        snapshotId: result.snapshotId,
        fromReplica,
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.copyOf ? { copyOf: input.copyOf } : {}),
        ...(writes ? { writes } : {}),
      },
    });
    await auditRetentionOutcome(
      ctx,
      { targetType: 'dbCluster', targetId: `${input.stack}/${input.cluster}` },
      result.retention,
    );
    const savedAt = new Date().toISOString();
    await stamp({
      at: savedAt,
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
      savedAt,
    };
  } catch (e) {
    await stamp({
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
  const run: BackupDbInput = {
    stack: input.stack,
    cluster: input.cluster,
    engine,
    targetId,
    database: input.database,
    dataVolume: input.dataVolume ?? schedule?.dataVolume,
    retentionDays: schedule?.retentionDays,
  };
  const saved = await backupDb(ctx, run);
  // A save into the schedule's own destination is copied on too, in the background.
  if (!input.targetId || input.targetId === schedule?.targetId) void copyAfter(ctx, primary, schedule, run, saved);
  return saved;
}

/** After a save that stamped `.lastRun`: copy it into the schedule's second destination. Never throws. */
function copyAfter(ctx: OrgContext, primary: InvService, schedule: DbBackupSchedule | null, input: BackupDbInput, saved: DbBackupRunView): Promise<unknown> {
  return copyAfterSave(ctx, {
    stack: input.stack,
    cluster: input.cluster,
    primaryService: primary.name,
    previous: primary.labels[DB_BACKUP_COPY_LABEL],
    engine: input.engine,
    targetId: input.targetId,
    secondaryTargetId: schedule?.secondaryTargetId,
    saved: { at: saved.savedAt, snapshotId: saved.snapshotId },
    copy: (dest) =>
      input.engine === 'wal-g'
        ? walgCopyInto(ctx, primary, input.targetId, dest, saved.snapshotId)
        : backupDb(ctx, { ...input, targetId: dest, copyOf: saved.snapshotId }).then((r) => ({ snapshotId: r.snapshotId, sizeBytes: r.sizeBytes })),
  });
}

/** wal-g PITR: `wal-g copy` of the base backup just pushed, and the WAL since it, on the node it ran on. */
async function walgCopyInto(ctx: OrgContext, primary: InvService, fromId: string, toId: string, backupName: string) {
  const from = await loadTarget(ctx, fromId);
  const to = await loadTarget(ctx, toId);
  const node = await physicalNode(ctx, primary.labels);
  const resticNetwork = resticNetworkFor(from.endpoint) ?? resticNetworkFor(to.endpoint);
  return walgCopy(ctx, { nodeId: node.id, from: toResticRepo(from), to: toResticRepo(to), backupName, resticNetwork });
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
      // Clearing is an explicit "don't back this up on a schedule": leave the
      // opt-out marker so default-on DB backups never re-create it.
      await ctx.hub.dispatch(node.id, 'service.updateLabels', {
        service: primary.name,
        add: { [DB_BACKUP_AUTO_LABEL]: DB_BACKUP_AUTO_OFF },
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

  assertEngineOffered(input.engine);
  try {
    parseCron(input.cron);
  } catch (e) {
    throw commandRejected(
      `invalid cron "${input.cron}": ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (isPhysicalEngine(input.engine) && !effectiveDataVolume(input.dataVolume, primary.labels)) {
    throw commandRejected(
      `engine "${input.engine}" needs the primary's PGDATA volume (dataVolume) to schedule`,
    );
  }
  if (input.targetId) await loadTarget(ctx, input.targetId); // org-scope check

  // The second destination is set on its own (`dbBackups.setSecondary`): saving
  // the schedule keeps it while it can still be copied there.
  const prev = parseScheduleLabel(primary.labels[DB_BACKUP_SCHEDULE_LABEL])?.secondaryTargetId;
  const keep = prev && prev !== input.targetId && copyMethod(input.engine) ? prev : undefined;
  const schedule: DbBackupSchedule = {
    cron: input.cron,
    engine: input.engine,
    retentionDays: input.retentionDays,
    pitr: input.pitr,
    ...(input.targetId ? { targetId: input.targetId } : {}),
    ...(input.dataVolume ? { dataVolume: input.dataVolume } : {}),
    ...(keep ? { secondaryTargetId: keep } : {}),
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
  const targets = await backupTargets(ctx, ctx.activeOrgId).findMany({
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
      // The agent's last read of the WAL repo beats the schedule's estimate.
      const read = knownPitrWindow(ctx.activeOrgId, `${p.stack}/${p.labels[DB_CLUSTER_LABEL] ?? ''}`, now.getTime());
      const estimate = pitrWindow(schedule, lastRun, now);
      const ref = `${p.stack}/${p.labels[DB_CLUSTER_LABEL] ?? ''}`;
      const copy = copyFields({ orgId: ctx.activeOrgId, ref, labels: p.labels, schedule, lastRun, targetName: (id) => targetName.get(id) ?? null, now: now.getTime() });
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
        lastError: lastRun?.error ?? null,
        lastSizeBytes: lastRun?.sizeBytes ?? null,
        nextRunAt,
        pitrWindow: read ? read.window : estimate,
        ...(read ? { pitrWindowSource: 'agent' as const } : schedule?.pitr ? { pitrWindowSource: 'estimate' as const } : {}),
        auto: schedule?.auto === true,
        ...copy,
      };
    })
    .sort((a, b) => `${a.stack}/${a.cluster}`.localeCompare(`${b.stack}/${b.cluster}`));
}

/**
 * The real recoverable window of a wal-g PITR cluster, read from its WAL repo
 * by the agent on the node that holds its data (the restore's own read). An
 * agent without the command answers `unsupported`; the estimate stays.
 */
export async function getDbPitrWindow(ctx: OrgContext, input: { stack: string; cluster: string; targetId?: string }): Promise<DbPitrWindowView> {
  const { primary } = findCluster(ctx, input.stack, input.cluster);
  if (!primary) throw notFound('db cluster primary', input.cluster);
  const schedule = parseScheduleLabel(primary.labels[DB_BACKUP_SCHEDULE_LABEL]);
  if (!schedule?.pitr || schedule.engine !== 'wal-g') return pitrWindowView(null);
  // `targetId`: the second copy's own window (a restore from it reaches only that far).
  const main = await resolveTargetId(ctx, undefined, schedule);
  const target = await loadTarget(ctx, input.targetId ?? main);
  const node = await physicalNode(ctx, primary.labels);
  try {
    const read = await readPitrWindow(ctx, {
      nodeId: node.id,
      repo: toResticRepo(target),
      network: clusterNetworkName(input.stack, input.cluster),
      resticNetwork: resticNetworkFor(target.endpoint),
    });
    if (read.status === 'read' && target.id === main) rememberPitrWindow(ctx.activeOrgId, `${input.stack}/${input.cluster}`, read.result);
    return pitrWindowView(read);
  } catch (e) {
    throw mapDispatchError(e);
  }
}

/** Where a read-only wal-g check of a PITR cluster runs: the restore's own node, destination and networks. */
export interface WalgClusterRead {
  nodeId: string;
  repo: ResticRepo;
  network: string;
  resticNetwork?: string;
  /** The live primary's connection; reads the password from its Docker secret, so call it only when needed. */
  conn: () => Promise<DbConnection>;
}

/** The read context of a wal-g PITR cluster, or null when the cluster archives no WAL with wal-g. */
export async function walgClusterRead(ctx: OrgContext, stack: string, cluster: string): Promise<WalgClusterRead | null> {
  const { primary } = findCluster(ctx, stack, cluster);
  if (!primary) throw notFound('db cluster primary', cluster);
  const schedule = parseScheduleLabel(primary.labels[DB_BACKUP_SCHEDULE_LABEL]);
  if (!schedule?.pitr || schedule.engine !== 'wal-g') return null;
  const target = await loadTarget(ctx, await resolveTargetId(ctx, undefined, schedule));
  const node = await physicalNode(ctx, primary.labels);
  return {
    nodeId: node.id,
    repo: toResticRepo(target),
    network: clusterNetworkName(stack, cluster),
    resticNetwork: resticNetworkFor(target.endpoint),
    conn: () => connFrom(ctx, stack, cluster, primary),
  };
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
      network: resticNetworkFor(target.endpoint),
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
  /**
   * Restore over the source WITHOUT saving its current data first. Only for
   * when the safety copy can't be taken (e.g. the server is down); audited.
   */
  skipSafetyBackup?: boolean;
}

export interface DbRestoreRunView {
  mode: DbRestoreMode;
  engine: DbBackupEngine;
  database?: string;
  bytesRestored: string;
  recoveredTo?: string;
  /** The pre-restore safety copy (a restore point; restore it to undo), or null for a copy / a skip. */
  safetySnapshotId: string | null;
}

/**
 * The PITR window check against the SOURCE cluster, for a restore whose
 * target doesn't exist yet ("restore as a copy"): refuse a target outside the
 * window before the copy is created. Same rules and skips as restoreDb's own
 * preflight (an engine or agent that can't read the window is a logged skip).
 */
export async function preflightPitrFromSource(
  ctx: OrgContext,
  input: { stack: string; cluster: string; engine: DbBackupEngine; targetId?: string; targetTime?: string; snapshotId?: string },
): Promise<void> {
  assertEngineOffered(input.engine);
  const { primary } = findCluster(ctx, input.stack, input.cluster);
  if (!primary) throw notFound('db cluster primary', `${input.stack}/${input.cluster}`);
  const schedule = parseScheduleLabel(primary.labels[DB_BACKUP_SCHEDULE_LABEL]);
  const target = await loadTarget(ctx, await resolveTargetId(ctx, input.targetId, schedule));
  const node = await physicalNode(ctx, primary.labels);
  await pitrPreflight(ctx, {
    ref: `${input.stack}/${input.cluster}`,
    engine: input.engine,
    targetTime: input.targetTime,
    snapshotId: input.snapshotId ?? 'latest',
    nodeId: node.id,
    repo: toResticRepo(target),
    network: clusterNetworkName(input.stack, input.cluster),
    resticNetwork: resticNetworkFor(target.endpoint),
  });
}

/** What a caller hears while a restore runs. */
export interface RestoreDbHooks {
  /** The pre-restore safety copy, as soon as it exists (a whole-app restore puts a failed part back from it). */
  onSafetyCopy?: (snapshotId: string) => void;
}

/**
 * `progress`: a run the caller already shows (restore as a copy: its own
 * `create` step first) and finishes itself; else this restore begins one.
 */
export async function restoreDb(ctx: OrgContext, input: RestoreDbInput, progress?: RestoreRun, hooks: RestoreDbHooks = {}): Promise<DbRestoreRunView> {
  assertEngineOffered(input.engine);
  const destStack = input.targetStack ?? input.stack;
  const destCluster = input.targetCluster ?? input.cluster;
  const { primary } = findCluster(ctx, destStack, destCluster);
  if (!primary) throw notFound('db cluster primary', destCluster);
  const dataVolume =
    input.mode === 'pitr' ? effectiveDataVolume(input.dataVolume, primary.labels) : input.dataVolume;
  if (input.mode === 'pitr' && !dataVolume) {
    throw commandRejected('pitr restore requires the target PGDATA volume (dataVolume)');
  }
  // Engine ↔ mode, checked here too (the agent keeps its own guards) so a
  // mismatch is refused before the safety copy is taken.
  if (input.mode === 'pitr' && !isPhysicalEngine(input.engine)) {
    throw commandRejected(`pitr restore requires a physical engine (wal-g/pgbackrest), got "${input.engine}"`);
  }
  if (input.mode !== 'pitr' && isPhysicalEngine(input.engine)) {
    throw commandRejected(`a ${input.engine} backup restores only to a point in time (pitr), not "${input.mode}"`);
  }
  const source = findCluster(ctx, input.stack, input.cluster).primary;
  const schedule = parseScheduleLabel(source?.labels[DB_BACKUP_SCHEDULE_LABEL]);
  const target = await loadTarget(ctx, await resolveTargetId(ctx, input.targetId, schedule));
  // A logical "latest" is pinned to a real save now, before the safety copy
  // becomes the newest one (PITR's "latest" is a wal-g base backup instead).
  let snapshotId = input.snapshotId ?? 'latest';
  if (input.mode !== 'pitr' && snapshotId.toLowerCase() === 'latest') {
    const saves = await listDbBackups(ctx, { targetId: target.id, stack: input.stack, cluster: input.cluster });
    const latest = latestRestorable(saves, input.engine);
    if (!latest) throw commandRejected(`there is no ${input.engine} backup of ${input.stack}/${input.cluster} to restore yet`);
    snapshotId = latest;
  }

  // PITR: read the real window first, so a target outside it is refused
  // before the safety copy and the stop. An older agent skips this (logged).
  const pitrNode = input.mode === 'pitr' ? await physicalNode(ctx, primary.labels) : null;
  if (pitrNode) {
    await pitrPreflight(ctx, {
      ref: `${input.stack}/${input.cluster}`,
      engine: input.engine,
      targetTime: input.targetTime,
      snapshotId,
      nodeId: pitrNode.id,
      repo: toResticRepo(target),
      network: clusterNetworkName(destStack, destCluster),
      resticNetwork: resticNetworkFor(target.endpoint),
    });
  }

  // From here on the restore card shows each step (`dbBackups.restoreProgress`).
  const run =
    progress ??
    restoreProgress.begin(ctx.activeOrgId, `${input.stack}/${input.cluster}`, {
      into: `${destStack}/${destCluster}`,
      mode: input.mode,
      engine: input.engine,
      targetTime: input.targetTime,
    });
  try {
    const view = await restoreAfterChecks(ctx, input, { destStack, destCluster, primary, dataVolume, schedule, target, snapshotId, pitrNode, run, hooks });
    if (!progress) run.finish(true);
    return view;
  } catch (e) {
    if (!progress) run.finish(false, e instanceof Error ? e.message : String(e));
    throw e;
  }
}

interface RestoreSteps {
  destStack: string;
  destCluster: string;
  primary: InvService;
  dataVolume: string | undefined;
  schedule: DbBackupSchedule | null;
  target: TargetRow;
  snapshotId: string;
  pitrNode: { id: string } | null;
  run: RestoreRun;
  hooks: RestoreDbHooks;
}

/** restoreDb once its checks passed: the safety copy, then the restore itself, each a step on `run`. */
async function restoreAfterChecks(ctx: OrgContext, input: RestoreDbInput, s: RestoreSteps): Promise<DbRestoreRunView> {
  const { destStack, destCluster, primary, dataVolume, schedule, target, snapshotId, pitrNode, run, hooks } = s;
  // Writing over the source? Save its current data first, or refuse.
  if (overwritesSource(input) && !input.skipSafetyBackup) run.stage('safety');
  const safety = await ensureSafetyCopy(ctx, input, (plan) =>
    backupDb(ctx, {
      stack: destStack,
      cluster: destCluster,
      engine: plan.engine,
      database: plan.database,
      targetId: target.id,
      retentionDays: schedule?.retentionDays,
      reason: PRE_RESTORE_REASON,
    }),
  );
  const safetySnapshotId = safety?.snapshotId ?? null;
  if (safetySnapshotId) hooks.onSafetyCopy?.(safetySnapshotId);
  const safetyAudit = { safetySnapshotId, safetySkipped: input.skipSafetyBackup === true && overwritesSource(input) };

  // PITR owns the whole stop → aside + fetch → start → promote sequence and
  // needs no DB password up front (QA-087).
  if (pitrNode) {
    const view = await runPitrRestore(ctx, {
      targetRef: `${destStack}/${destCluster}`,
      service: primary.name,
      desiredReplicas: primary.replicas.desired,
      passwordSecret: primary.labels[DB_PASSWORD_SECRET_LABEL] || undefined,
      replicationUser: envRecord(primary)[PG_ENV.replicationUser] || 'repl',
      nodeId: pitrNode.id,
      dataVolume: dataVolume!,
      engine: input.engine,
      snapshotId,
      targetTime: input.targetTime,
      repo: toResticRepo(target),
      tags: dbTags(ctx.activeOrgId, destStack, destCluster, input.engine),
      network: clusterNetworkName(destStack, destCluster),
      resticNetwork: resticNetworkFor(target.endpoint),
      targetId: target.id,
      safety: safetyAudit,
      progress: run,
      ...engineImageFor(input.engine),
    });
    return { mode: view.mode, engine: view.engine, bytesRestored: view.bytesRestored, recoveredTo: view.recoveredTo, safetySnapshotId };
  }

  run.stage('download');
  const conn = await connFrom(ctx, destStack, destCluster, primary, input.database);
  const node = await resolveManagerNode(ctx);
  try {
    const result = await ctx.hub.dispatch<DbRestoreResult>(node.id, 'db.restore', {
      // An older agent ignores it and reports only the result.
      reportProgress: true,
      engine: input.engine,
      mode: input.mode,
      conn,
      repo: toResticRepo(target),
      snapshotId,
      targetTime: input.targetTime,
      database: input.database,
      tags: dbTags(ctx.activeOrgId, destStack, destCluster, input.engine),
      network: clusterNetworkName(destStack, destCluster),
      resticNetwork: resticNetworkFor(target.endpoint),
      dataVolume,
    }, { onProgress: (p) => run.agent(p) });
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
        ...safetyAudit,
      },
    });
    return {
      mode: result.mode,
      engine: result.engine,
      database: result.database,
      bytesRestored: String(result.bytesRestored),
      recoveredTo: result.recoveredTo,
      safetySnapshotId,
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
        const input: BackupDbInput = {
          stack,
          cluster,
          engine: schedule.engine,
          targetId,
          dataVolume: schedule.dataVolume,
          retentionDays: schedule.retentionDays,
        };
        const saved = await backupDb(ctx, input);
        await copyAfter(ctx, primary, schedule, input, saved);
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
