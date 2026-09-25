/**
 * Default-on database backups — the IO half. Pure detection / destination /
 * stagger / planning lives in `./autoBackup` (golden-tested); this module reads
 * Docker truth + the org's destinations and converges:
 *
 *   - managed Postgres → stamp the `swarmy.db.backup.schedule` label (auto
 *     nightly `pg_dump`, keep 7) on the primary, and
 *   - compose/blueprint DBs → create an `auto` `BackupSchedule` row (nightly
 *     volume backup, keep 7 — crash-consistent, see `./autoBackup`).
 *
 * Run by the backup-scheduler worker every few minutes (so a destination added
 * later picks up every unscheduled DB) and by `provisionDb` at create time.
 * Every schedule it creates is audited as `backup.schedule.auto` under the
 * system actor. With no destination nothing is created and nothing fails —
 * the stack's Backups tab shows "Backups are off — add a destination".
 */
import { backupSchedules, backupTargets } from './backups.repo';
import type { Auth } from '@swarmy/auth';
import type { DB } from '@swarmy/db';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import type { AgentHub } from '../hub/types';
import { writeAudit } from './audit.service';
import {
  AUTO_BACKUP_RETENTION_DAYS,
  DB_BACKUP_AUTO_LABEL,
  DB_BACKUP_AUTO_OFF,
  chooseAutoBackupTarget,
  chooseAutoSecondaryTarget,
  detectBackupVolumes,
  detectDbServices,
  nextExcludeLabel,
  volumeAutoOptOut,
  VOLUME_BACKUP_AUTO_LABEL,
  VOLUME_BACKUP_EXCLUDE_LABEL,
  planManagedAutoSchedule,
  shouldCreateVolumeSchedule,
  staggeredAnchor,
  type AutoTargetCandidate,
  type DetectedDbEngine,
} from './autoBackup';
import { appDbCoverage, detectAppDbs, type AppDbCoverage } from './appDbBackup.service';
import { systemContext } from './cicd.service';
import {
  DB_BACKUP_LAST_RUN_LABEL,
  DB_BACKUP_SCHEDULE_LABEL,
  autoDbSchedule,
  encodeScheduleLabel,
  parseLastRunLabel,
  parseScheduleLabel,
} from './dbBackup.service';
import { resolveManagerNode } from './dispatch.service';
import { notFound } from '../errors';
import {
  DB_CLUSTER_LABEL,
  DB_ENGINE_LABEL,
  DB_MEMBER_LABEL,
  DB_ROLE_LABEL,
  DB_WAL_SHIPPER_LABEL,
  runningTaskOf,
} from './manageddb.service';
import { cronNext, parseCron } from './schedule';
import { lastRunBySchedule, scheduleNextRunAt } from './backupSchedule.service';

export const AUTO_SCHEDULE_AUDIT_ACTION = 'backup.schedule.auto';
const STACK_LABEL = 'com.docker.stack.namespace';
const DAILY = { every: 1, unit: 'days' as const };
/** Don't re-stamp a label the inventory hasn't reflected yet (it lags a tick). */
const RESTAMP_GUARD_MS = 10 * 60_000;
const recentStamps = new Map<string, number>();

interface TargetRow extends AutoTargetCandidate {
  createdAt: Date;
}

interface ScheduleRow {
  id: string;
  targetId: string;
  secondaryTargetId: string | null;
  volume: string;
  auto: boolean;
  optedOutAt: Date | null;
  retentionDays: number | null;
  paused: boolean;
  every: number;
  unit: string;
  createdAt: Date;
  anchorAt: Date | null;
}

/** Schedules live in the org's swarm (swarm-kv `bkp-sched`). */
function scheduleDb(ctx: OrgContext): {
  findMany(a: unknown): Promise<ScheduleRow[]>;
  create(a: unknown): Promise<ScheduleRow>;
  update(a: unknown): Promise<ScheduleRow>;
  delete(a: unknown): Promise<ScheduleRow>;
} {
  return backupSchedules(ctx, ctx.activeOrgId) as never;
}

async function loadTargets(ctx: OrgContext): Promise<TargetRow[]> {
  return (await backupTargets(ctx, ctx.activeOrgId).findMany({
    where: { orgId: ctx.activeOrgId },
    select: { id: true, name: true, kind: true, enabled: true, createdAt: true },
  })) as unknown as TargetRow[];
}

/** The destination default-on backups use right now (see `chooseAutoBackupTarget`). */
export async function resolveAutoBackupTarget(
  ctx: OrgContext,
): Promise<{ id: string; name: string; kind: string } | null> {
  const t = chooseAutoBackupTarget(await loadTargets(ctx));
  return t ? { id: t.id, name: t.name, kind: t.kind } : null;
}

function isBasePrimary(s: SwarmServiceInfo): boolean {
  return (
    Boolean(s.labels[DB_CLUSTER_LABEL]) &&
    s.labels[DB_ROLE_LABEL] === 'primary' &&
    !s.labels[DB_MEMBER_LABEL] &&
    s.labels[DB_WAL_SHIPPER_LABEL] !== 'true' &&
    (s.labels[DB_ENGINE_LABEL] ?? 'postgres') === 'postgres'
  );
}

// ── provision-time hook (managed Postgres) ───────────────────────────────────

/**
 * Labels `provisionDb` should add to a NEW/re-provisioned primary so it is
 * born with its nightly backup. Empty when the primary already declares a
 * schedule (user or auto), carries the opt-out marker, or no destination
 * exists (the loop picks it up once one is added). Never throws.
 */
export async function autoDbScheduleLabels(
  ctx: OrgContext,
  stack: string,
  cluster: string,
  existingLabels: Record<string, string> | undefined,
): Promise<{ labels: Record<string, string>; targetId?: string; cron?: string }> {
  try {
    const labels = existingLabels ?? {};
    const targets = await loadTargets(ctx);
    const target = chooseAutoBackupTarget(targets);
    const plan = planManagedAutoSchedule({
      stack,
      cluster,
      labels,
      schedule: parseScheduleLabel(labels[DB_BACKUP_SCHEDULE_LABEL]),
      target,
      enabledTargetIds: new Set(targets.filter((t) => t.enabled).map((t) => t.id)),
    });
    if (plan.action !== 'stamp') return { labels: {} };
    const schedule = autoDbSchedule(stack, cluster, plan.targetId);
    return {
      labels: { [DB_BACKUP_SCHEDULE_LABEL]: encodeScheduleLabel(schedule) },
      targetId: plan.targetId,
      cron: schedule.cron,
    };
  } catch {
    return { labels: {} }; // best-effort: a backup default must never fail a provision
  }
}

/** The single audit row every auto-created schedule leaves. */
export async function auditAutoSchedule(
  ctx: OrgContext,
  entry: { targetType: string; targetId: string; metadata: Record<string, unknown> },
): Promise<void> {
  await writeAudit(ctx, {
    action: AUTO_SCHEDULE_AUDIT_ACTION,
    actorType: 'system',
    targetType: entry.targetType,
    targetId: entry.targetId,
    metadata: entry.metadata,
  }).catch(() => undefined);
}

// ── the loop body (one org) ─────────────────────────────────────────────────

export interface AutoBackupSweepResult {
  destination: string | null;
  managedStamped: number;
  volumeSchedulesCreated: number;
  /** Auto volume schedules removed because the app/volume opted out by label. */
  volumeSchedulesRetired: number;
}

/**
 * Converge default-on backups for one org. Idempotent: a DB that already has
 * any schedule (or an opt-out) is left alone, so a steady state writes nothing.
 */
export async function ensureAutoBackupsForOrg(
  ctx: OrgContext,
  now: Date = new Date(),
): Promise<AutoBackupSweepResult> {
  const result: AutoBackupSweepResult = {
    destination: null,
    managedStamped: 0,
    volumeSchedulesCreated: 0,
    volumeSchedulesRetired: 0,
  };
  const targets = await loadTargets(ctx);
  const target = chooseAutoBackupTarget(targets);
  result.destination = target?.id ?? null;
  if (!target) return result; // no destination: surfaced as a warning, never an error
  const enabledTargetIds = new Set(targets.filter((t) => t.enabled).map((t) => t.id));
  const services = ctx.hub.liveInventory(ctx.activeOrgId).services;

  // 1. Managed Postgres clusters → the schedule label on the primary.
  for (const primary of services.filter(isBasePrimary)) {
    const stack = primary.labels[STACK_LABEL] ?? '';
    const cluster = primary.labels[DB_CLUSTER_LABEL]!;
    const plan = planManagedAutoSchedule({
      stack,
      cluster,
      labels: primary.labels,
      schedule: parseScheduleLabel(primary.labels[DB_BACKUP_SCHEDULE_LABEL]),
      target,
      enabledTargetIds,
    });
    if (plan.action !== 'stamp') continue;
    const guardKey = `${ctx.activeOrgId}/${primary.name}/${plan.targetId}`;
    const last = recentStamps.get(guardKey);
    if (last && now.getTime() - last < RESTAMP_GUARD_MS) continue;
    const schedule = autoDbSchedule(stack, cluster, plan.targetId);
    try {
      const node = await resolveManagerNode(ctx);
      await ctx.hub.dispatch(node.id, 'service.updateLabels', {
        service: primary.name,
        add: { [DB_BACKUP_SCHEDULE_LABEL]: encodeScheduleLabel(schedule) },
        removeKeys: [],
      });
    } catch {
      continue; // retried next sweep
    }
    recentStamps.set(guardKey, now.getTime());
    result.managedStamped++;
    await auditAutoSchedule(ctx, {
      targetType: 'dbCluster',
      targetId: `${stack}/${cluster}`,
      metadata: {
        kind: 'managed',
        engine: schedule.engine,
        cron: schedule.cron,
        retentionDays: schedule.retentionDays,
        targetId: plan.targetId,
        repoint: plan.repoint,
      },
    });
  }

  // 2. Every named volume (compose DBs first) → an auto daily volume-backup
  //    row to the chosen destination, also copied to an off-box S3 target
  //    when the primary is the in-cluster Garage store.
  const secondary = chooseAutoSecondaryTarget(targets, target);
  const detected = detectBackupVolumes(services);
  if (detected.length === 0) return result;
  const existing = await scheduleDb(ctx).findMany({
    where: { orgId: ctx.activeOrgId, volume: { in: detected.map((d) => d.volume) } },
  });
  const byStack = new Map<string, SwarmServiceInfo[]>();
  for (const s of services) {
    const st = s.labels[STACK_LABEL];
    if (st) byStack.set(st, [...(byStack.get(st) ?? []), s]);
  }
  for (const d of detected) {
    const optOut = volumeAutoOptOut(d, byStack.get(d.stack) ?? []);
    if (optOut) {
      // The app/volume opted out by label: retire its live AUTO schedule (a
      // user's own schedule is theirs). Deleted, not tombstoned, so clearing
      // the label brings the default back; snapshots are kept.
      for (const row of existing.filter((r) => r.volume === d.volume && r.auto && !r.optedOutAt)) {
        try {
          await scheduleDb(ctx).delete({ where: { id: row.id } });
        } catch {
          continue;
        }
        existing.splice(existing.indexOf(row), 1);
        result.volumeSchedulesRetired++;
        await auditAutoSchedule(ctx, {
          targetType: 'backupSchedule',
          targetId: row.id,
          metadata: { kind: 'volume', stack: d.stack, volume: d.volume, retired: true, optOut },
        });
      }
      continue;
    }
    // Back-fill the off-box copy on auto rows made before one existed.
    if (secondary) {
      for (const row of existing.filter((r) => r.volume === d.volume && r.auto && !r.optedOutAt && !r.secondaryTargetId && r.targetId === target.id)) {
        try {
          await scheduleDb(ctx).update({ where: { id: row.id }, data: { secondaryTargetId: secondary.id } });
          row.secondaryTargetId = secondary.id;
        } catch {
          // next sweep retries
        }
      }
    }
    if (!shouldCreateVolumeSchedule(d.volume, existing)) continue;
    const svc = services.find((s) => s.name === d.service);
    const nodeId = svc ? (runningTaskOf(ctx, svc)?.nodeId ?? null) : null;
    // A plain volume lives on the node its task runs on; with no running task
    // we can't say which node's copy to take — wait for the next sweep rather
    // than back up an empty volume on a manager. (DBs keep the old fallback.)
    if (!nodeId && !d.engine) continue;
    const anchor = staggeredAnchor(`${d.stack}/${d.volume}`, now);
    let row: ScheduleRow;
    try {
      row = await scheduleDb(ctx).create({
        data: {
          orgId: ctx.activeOrgId,
          targetId: target.id,
          secondaryTargetId: secondary?.id ?? null,
          volume: d.volume,
          nodeId,
          every: DAILY.every,
          unit: DAILY.unit,
          paused: false,
          auto: true,
          retentionDays: AUTO_BACKUP_RETENTION_DAYS,
          anchorAt: anchor,
        },
      });
    } catch {
      continue;
    }
    existing.push(row);
    result.volumeSchedulesCreated++;
    await auditAutoSchedule(ctx, {
      targetType: 'backupSchedule',
      targetId: row.id,
      metadata: {
        kind: 'volume',
        stack: d.stack,
        service: d.service,
        ...(d.engine ? { engine: d.engine } : {}),
        volume: d.volume,
        every: DAILY.every,
        unit: DAILY.unit,
        retentionDays: AUTO_BACKUP_RETENTION_DAYS,
        targetId: target.id,
        ...(secondary ? { secondaryTargetId: secondary.id } : {}),
        consistency: 'crash-consistent',
      },
    });
  }
  return result;
}

export interface EnsureAutoBackupsDeps {
  db: DB;
  hub: AgentHub;
  auth: Auth;
}

/** Every org with a connected manager; one org's failure never stops the rest. */
export async function ensureAutoBackups(
  deps: EnsureAutoBackupsDeps,
  now: Date = new Date(),
): Promise<void> {
  const orgs = await deps.db.organization.findMany({ select: { id: true } });
  for (const org of orgs) {
    if (!deps.hub.managerNode(org.id)) continue;
    try {
      await ensureAutoBackupsForOrg(systemContext(deps, org.id), now);
    } catch {
      // next sweep retries
    }
  }
}

// ── stack coverage (the stack Backups tab) ──────────────────────────────────

export type AutoCoverageStatus = 'auto' | 'user' | 'opted-out' | 'unscheduled';

export interface AutoCoverageDb {
  kind: 'managed' | 'compose';
  /** Cluster name (managed) or service name (compose). */
  name: string;
  engine: DetectedDbEngine;
  /** Compose: the data volume backed up. */
  volume: string | null;
  status: AutoCoverageStatus;
  /** How it is backed up: the DB engine (`pg_dump`, …) or `volume` — a
   *  crash-consistent copy of the live data volume. */
  method: string;
  retentionDays: number | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  /**
   * Compose MySQL/MariaDB/Mongo/Redis/Valkey: the logical dump that rides the
   * same schedule (belt and braces with the volume copy), or `volume-only`
   * with the reason when the credentials can't be resolved. Null otherwise.
   */
  logical: AppDbCoverage | null;
}

/** A plain named volume (not a database) and how default backups cover it. */
export interface AutoCoverageVolume {
  volume: string;
  service: string;
  status: AutoCoverageStatus;
  /** Set when opted out by label: the whole app, or this one volume. */
  optOut: 'app' | 'volume' | null;
  retentionDays: number | null;
  nextRunAt: string | null;
  /** The "also copy to" destination of the covering schedule, if any. */
  secondaryTargetId: string | null;
}

export interface AutoCoverageView {
  stack: string;
  destination: { id: string; name: string } | null;
  databases: AutoCoverageDb[];
  /** Every other named volume of the stack (default-on nightly copy). */
  volumes: AutoCoverageVolume[];
  /** `swarmy.backup.auto=off` on the stack: default volume backups are off for this app. */
  appOptedOut: boolean;
}

/** This stack's databases and how default-on backups cover each one. */
export async function autoBackupCoverage(
  ctx: OrgContext,
  stack: string,
): Promise<AutoCoverageView> {
  const now = new Date();
  const target = await resolveAutoBackupTarget(ctx);
  const services = ctx.hub
    .liveInventory(ctx.activeOrgId)
    .services.filter((s) => s.labels[STACK_LABEL] === stack);
  const databases: AutoCoverageDb[] = [];

  for (const p of services.filter(isBasePrimary)) {
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
    databases.push({
      kind: 'managed',
      name: p.labels[DB_CLUSTER_LABEL]!,
      engine: 'postgres',
      volume: null,
      status: schedule
        ? schedule.auto
          ? 'auto'
          : 'user'
        : p.labels[DB_BACKUP_AUTO_LABEL] === DB_BACKUP_AUTO_OFF
          ? 'opted-out'
          : 'unscheduled',
      method: schedule?.engine ?? 'pg_dump',
      retentionDays: schedule?.retentionDays ?? null,
      nextRunAt,
      lastRunAt: lastRun?.at ?? null,
      logical: null,
    });
  }

  const all = detectBackupVolumes(services);
  const detected = detectDbServices(services);
  const appDbs = detectAppDbs(services);
  const logical = await appDbCoverage(ctx, appDbs);
  const rows =
    all.length > 0
      ? await scheduleDb(ctx).findMany({
          where: { orgId: ctx.activeOrgId, volume: { in: all.map((d) => d.volume) } },
        })
      : [];
  const lastRuns = await lastRunBySchedule(ctx.db, rows.map((r) => r.id));
  const cover = (volume: string) => {
    const mine = rows.filter((r) => r.volume === volume);
    const live = mine.filter((r) => !r.optedOutAt);
    const user = live.find((r) => !r.auto);
    const auto = live.find((r) => r.auto);
    const current = user ?? auto;
    const optOut = volumeAutoOptOut({ stack, service: '', volume, engine: null }, services);
    const status: AutoCoverageStatus = user
      ? 'user'
      : auto
        ? 'auto'
        : mine.length > 0 || optOut
          ? 'opted-out'
          : 'unscheduled';
    return {
      status,
      optOut: user || auto ? null : optOut,
      current,
      nextRunAt:
        current && !current.paused
          ? (scheduleNextRunAt(current, lastRuns.get(current.id) ?? null)?.toISOString() ?? null)
          : null,
    };
  };
  for (const d of detected) {
    const c = cover(d.volume);
    databases.push({
      kind: 'compose',
      name: d.service,
      engine: d.engine,
      volume: d.volume,
      status: c.status,
      method: 'volume',
      retentionDays: c.current?.retentionDays ?? null,
      nextRunAt: c.nextRunAt,
      lastRunAt: logical.get(`${d.stack}/${d.service}`)?.lastAt ?? null,
      logical: logical.get(`${d.stack}/${d.service}`) ?? null,
    });
  }
  const volumes: AutoCoverageVolume[] = all
    .filter((v) => !v.engine)
    .map((v) => {
      const c = cover(v.volume);
      return {
        volume: v.volume,
        service: v.service,
        status: c.status,
        optOut: c.optOut,
        retentionDays: c.current?.retentionDays ?? null,
        nextRunAt: c.nextRunAt,
        secondaryTargetId: c.current?.secondaryTargetId ?? null,
      };
    });

  return {
    stack,
    destination: target ? { id: target.id, name: target.name } : null,
    databases,
    volumes,
    appOptedOut: services.some((s) => s.labels[VOLUME_BACKUP_AUTO_LABEL]?.trim().toLowerCase() === DB_BACKUP_AUTO_OFF),
  };
}

// ── opt-out / opt back in (per app, per volume) ──────────────────────────────

/**
 * Turn default volume backups off (or back on) for a whole app, or for one of
 * its volumes. Docker truth: the `swarmy.backup.auto` / `.exclude` labels are
 * stamped on every service of the stack (like the retention label), and the
 * next sweep retires or re-creates the auto schedules. Turning a volume back
 * ON also clears its removed-auto-schedule tombstone. A user's own schedule is
 * never touched. Audited as `backup.auto.set`.
 */
export async function setAutoVolumeBackup(
  ctx: OrgContext,
  input: { stack: string; volume?: string; enabled: boolean },
): Promise<{ stack: string; volume: string | null; enabled: boolean }> {
  const services = ctx.hub
    .liveInventory(ctx.activeOrgId)
    .services.filter((s) => s.labels[STACK_LABEL] === input.stack);
  if (services.length === 0) throw notFound('stack', input.stack);
  const node = await resolveManagerNode(ctx);
  for (const s of services) {
    let add: Record<string, string> = {};
    let removeKeys: string[] = [];
    if (input.volume) {
      const next = nextExcludeLabel(s.labels[VOLUME_BACKUP_EXCLUDE_LABEL], input.volume, input.stack, !input.enabled);
      if ((next ?? undefined) === s.labels[VOLUME_BACKUP_EXCLUDE_LABEL]) continue;
      if (next) add = { [VOLUME_BACKUP_EXCLUDE_LABEL]: next };
      else removeKeys = [VOLUME_BACKUP_EXCLUDE_LABEL];
    } else if (input.enabled) {
      if (!(VOLUME_BACKUP_AUTO_LABEL in s.labels)) continue;
      removeKeys = [VOLUME_BACKUP_AUTO_LABEL];
    } else {
      if (s.labels[VOLUME_BACKUP_AUTO_LABEL] === DB_BACKUP_AUTO_OFF) continue;
      add = { [VOLUME_BACKUP_AUTO_LABEL]: DB_BACKUP_AUTO_OFF };
    }
    await ctx.hub.dispatch(node.id, 'service.updateLabels', { service: s.name, add, removeKeys });
  }
  if (input.enabled && input.volume) {
    const tombstones = await scheduleDb(ctx).findMany({
      where: { orgId: ctx.activeOrgId, volume: input.volume, auto: true },
    });
    for (const t of tombstones.filter((r) => r.optedOutAt)) {
      await scheduleDb(ctx).delete({ where: { id: t.id } }).catch(() => undefined);
    }
  }
  await writeAudit(ctx, {
    action: 'backup.auto.set',
    actorType: ctx.user ? 'user' : 'system',
    targetType: input.volume ? 'volume' : 'stack',
    targetId: input.volume ?? input.stack,
    metadata: { stack: input.stack, volume: input.volume ?? null, enabled: input.enabled },
  });
  return { stack: input.stack, volume: input.volume ?? null, enabled: input.enabled };
}
