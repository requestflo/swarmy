/**
 * Backup scheduler worker (epic: volumes-dr, P2).
 *
 * Every minute: find non-paused `BackupSchedule`s that are due, dispatch a
 * `runBackup` to a node that hosts the volume (or an online manager) and record
 * a `BackupJob` row. No run state is stored on the schedule: the last run is
 * the newest `BackupJob`, and the next run is the first interval slot after it
 * (`nextIntervalRun` in `@swarmy/trpc` schedule.ts). A due schedule whose
 * target or node is unavailable stays due and is retried next tick. Secrets
 * are decrypted just-in-time from the target.
 *
 * Mirrors `metrics-sampler`/`retention`: prisma + the shared gateway hub.
 */
import { prisma } from '@swarmy/db';
import { buildInventory } from '@swarmy/core';
import { decryptSecret } from '@swarmy/core/crypto';
import type { BackupVolumeResult, ResticRepo } from '@swarmy/core/protocol';
import {
  allOrgRows,
  backupSchedules,
  backupTargets,
  ensureAutoBackups,
  resticNetworkFor,
  runScheduledAppDbDump,
  stackRetentionFor,
} from '@swarmy/trpc';
import { authRegistry } from '@swarmy/auth';
import { hub, registry } from '../gateway';

const TICK_MS = 60_000;
/** Default-on DB backups converge every few minutes (and once shortly after boot). */
const AUTO_BACKUP_EVERY_TICKS = 5;
const AUTO_BACKUP_FIRST_RUN_MS = 45_000;

// ── schedule calc ────────────────────────────────────────────────────────────
// Mirror of @swarmy/trpc `schedule.ts` (the unit-tested canonical copy). Inlined
// here because the worker cannot subpath-import an internal trpc module.
type IntervalUnit = 'minutes' | 'hours' | 'days';
interface ScheduleSpec {
  every: number;
  unit: IntervalUnit;
}
const UNIT_MS: Record<IntervalUnit, number> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};
function nextRun(spec: ScheduleSpec, anchor: Date, from: Date): Date {
  const step = spec.every * UNIT_MS[spec.unit];
  const anchorMs = anchor.getTime();
  const fromMs = from.getTime();
  if (fromMs < anchorMs) return new Date(anchorMs);
  const k = Math.floor((fromMs - anchorMs) / step) + 1;
  return new Date(anchorMs + k * step);
}
/** Mirror of `nextIntervalRun`: the slot after the last run (or creation). */
function nextIntervalRun(spec: ScheduleSpec, anchor: Date, createdAt: Date, lastRunAt: Date | null): Date {
  return nextRun(spec, anchor, lastRunAt ?? createdAt);
}

interface TargetRow {
  id: string;
  kind: string;
  endpoint: string | null;
  bucket: string;
  prefix: string | null;
  region: string | null;
  credentialRef: string | null;
  secretKeyRef: string | null;
  resticPasswordRef: string;
}

function repoUrl(t: TargetRow): string {
  const prefix = t.prefix ? `/${t.prefix.replace(/^\/+/, '')}` : '';
  if (t.kind === 'NODE' || t.kind === 'node') return `${t.bucket.replace(/\/+$/, '')}${prefix}`;
  const endpoint = (t.endpoint ?? '').replace(/\/+$/, '');
  return `s3:${endpoint}/${t.bucket}${prefix}`;
}

function toRepo(t: TargetRow): ResticRepo {
  return {
    kind: t.kind === 'NODE' || t.kind === 'node' ? 'node' : 's3',
    repo: repoUrl(t),
    password: decryptSecret(t.resticPasswordRef),
    endpoint: t.endpoint ?? undefined,
    region: t.region ?? undefined,
    accessKeyId: t.credentialRef ? decryptSecret(t.credentialRef) : undefined,
    secretAccessKey: t.secretKeyRef ? decryptSecret(t.secretKeyRef) : undefined,
  };
}

/** Resolve the volume's stack-level retention window from live Docker truth.
 *  The stack label wins; else the schedule's own window (auto schedules: 7). */
function retentionFor(orgId: string, volume: string, fallback: number | null): number | null {
  return stackRetentionForVolume(orgId, volume) ?? fallback;
}

function stackRetentionForVolume(orgId: string, volume: string): number | null {
  try {
    const { services, containers } = hub.liveInventory(orgId);
    return stackRetentionFor(buildInventory(services, containers).services, volume);
  } catch {
    return null; // no inventory (agent flapping) → back up without pruning
  }
}

/**
 * Retention is destructive: leave one audit row per prune that removed
 * snapshots, and one per retention FAILURE (the backup itself succeeded).
 */
async function auditRetention(
  orgId: string,
  volume: string,
  snapshotId: string,
  retention: BackupVolumeResult['retention'],
): Promise<void> {
  if (!retention) return;
  if (retention.snapshotsRemoved === 0 && !retention.error) return;
  await (prisma as unknown as { auditLog: { create(a: unknown): Promise<unknown> } }).auditLog
    .create({
      data: {
        orgId,
        actorType: 'system',
        action: retention.error ? 'backup.retention.failed' : 'backup.retention.prune',
        targetType: 'snapshot',
        targetId: snapshotId,
        metadata: {
          volume,
          retentionDays: retention.retentionDays,
          snapshotsRemoved: retention.snapshotsRemoved,
          ...(retention.error ? { error: retention.error } : {}),
        },
      },
    })
    .catch(() => undefined);
}

/** Pick an online node to run the backup: the recorded host, else any online
 *  swarm manager (Docker truth via the hub — no DB Node role column). */
async function pickNode(orgId: string, preferredNodeId: string | null): Promise<string | null> {
  if (preferredNodeId && registry.isOnline(preferredNodeId)) return preferredNodeId;
  // `hub.managerNodes` already returns only connected swarm managers for the org.
  return hub.managerNodes(orgId)[0] ?? null;
}

async function runDue(): Promise<void> {
  const now = new Date();
  // `backupSchedule` is added to the Prisma schema as part of this epic.
  const db = prisma as unknown as {
    backupSchedule: {
      findMany(a: unknown): Promise<
        Array<{
          id: string;
          orgId: string;
          targetId: string;
          volume: string;
          nodeId: string | null;
          every: number;
          unit: string;
          paused: boolean;
          createdAt: Date;
          anchorAt: Date | null;
          retentionDays: number | null;
        }>
      >;
    };
    backupJob: {
      create(a: unknown): Promise<{ id: string }>;
      update(a: unknown): Promise<unknown>;
      groupBy(a: unknown): Promise<Array<{ scheduleId: string | null; _max: { startedAt: Date | null } }>>;
    };
    backupTarget: { findUnique(a: unknown): Promise<TargetRow | null> };
    snapshot: { create(a: unknown): Promise<{ id: string }>; update(a: unknown): Promise<unknown> };
  };

  // Schedules live in each org's swarm (swarm-kv); orgs without a connected
  // manager are skipped this tick (they couldn't run a backup anyway).
  const active = await allOrgRows({ db: prisma, hub }, backupSchedules, { where: { paused: false, optedOutAt: null } });
  if (active.length === 0) return;
  const lastRuns = await db.backupJob.groupBy({
    by: ['scheduleId'],
    where: { scheduleId: { in: active.map((s) => s.id) } },
    _max: { startedAt: true },
  });
  const lastRunOf = new Map<string, Date>();
  for (const r of lastRuns) if (r.scheduleId && r._max.startedAt) lastRunOf.set(r.scheduleId, r._max.startedAt);
  const due = active.filter((sched) => {
    if (inFlight.has(sched.id)) return false;
    const spec: ScheduleSpec = { every: sched.every, unit: sched.unit as ScheduleSpec['unit'] };
    if (!(spec.every > 0) || !UNIT_MS[spec.unit]) return false;
    const next = nextIntervalRun(spec, sched.anchorAt ?? sched.createdAt, sched.createdAt, lastRunOf.get(sched.id) ?? null);
    return next.getTime() <= now.getTime();
  });

  for (const sched of due) {
    inFlight.add(sched.id);
    try {
      await runOne(db, sched, now);
    } finally {
      inFlight.delete(sched.id);
    }
  }
}

/** Schedules with a run in progress in this process (belt and braces: the
 *  `BackupJob` row written before dispatch already makes them not-due). */
const inFlight = new Set<string>();

type SchedDb = {
  backupJob: { create(a: unknown): Promise<{ id: string }>; update(a: unknown): Promise<unknown> };
  backupTarget: { findUnique(a: unknown): Promise<TargetRow | null> };
  snapshot: { create(a: unknown): Promise<{ id: string }>; update(a: unknown): Promise<unknown> };
};

async function runOne(
  db: SchedDb,
  sched: { id: string; orgId: string; targetId: string; volume: string; nodeId: string | null; retentionDays: number | null },
  now: Date,
): Promise<void> {
  {
    const target = (await backupTargets({ db: prisma, hub }, sched.orgId).findFirst({
      where: { id: sched.targetId },
    })) as unknown as TargetRow | null;
    if (!target) return;
    const nodeId = await pickNode(sched.orgId, sched.nodeId);
    if (!nodeId) return;

    // The history row IS the "last run": written before dispatch so a slow run
    // (or an overlapping tick) never double-fires.
    const job = await db.backupJob.create({
      data: { orgId: sched.orgId, scheduleId: sched.id, status: 'RUNNING', startedAt: now },
    });
    const snapshot = await db.snapshot.create({
      data: {
        orgId: sched.orgId,
        targetId: target.id,
        volume: sched.volume,
        status: 'RUNNING',
        hostNodeId: nodeId,
      },
    });

    // The stack's retention label (`swarmy.backup.retentionDays`) rides the
    // dispatch; the agent enforces it with `restic forget --keep-within --prune`
    // after the backup succeeds. Absent label = keep forever.
    const retentionDays = retentionFor(sched.orgId, sched.volume, sched.retentionDays);

    try {
      const result = await hub.dispatch<BackupVolumeResult>(nodeId, 'backup.run', {
        jobId: snapshot.id,
        repo: toRepo(target),
        volume: sched.volume,
        tags: [`org:${sched.orgId}`, `volume:${sched.volume}`],
        ...(retentionDays != null ? { retentionDays } : {}),
        // In-cluster destinations (native `swarmy-garage`) only resolve on the swarmy overlay.
        network: resticNetworkFor(target.endpoint),
      });
      await db.snapshot.update({
        where: { id: snapshot.id },
        data: {
          status: 'SUCCEEDED',
          resticId: result.snapshotId,
          sizeBytes: BigInt(result.sizeBytes),
          finishedAt: new Date(),
        },
      });
      await db.backupJob.update({
        where: { id: job.id },
        data: { status: 'SUCCEEDED', finishedAt: new Date(), snapshotId: snapshot.id },
      });
      await auditRetention(sched.orgId, sched.volume, snapshot.id, result.retention);
    } catch (e) {
      await db.snapshot.update({
        where: { id: snapshot.id },
        data: {
          status: 'FAILED',
          error: e instanceof Error ? e.message : String(e),
          finishedAt: new Date(),
        },
      });
      await db.backupJob.update({
        where: { id: job.id },
        data: { status: 'FAILED', finishedAt: new Date(), error: e instanceof Error ? e.message : String(e) },
      });
    }

    // Belt and braces: when the volume is a compose MySQL/MariaDB/Mongo/Redis/
    // Valkey data volume, also take a transaction-consistent logical dump to the
    // same destination with the same retention (skipped, not failed, when its
    // credentials can't be resolved — the volume copy above still covers it).
    await runScheduledAppDbDump(
      { db: prisma, hub, auth: authRegistry.getAuth() },
      { orgId: sched.orgId, volume: sched.volume, targetId: target.id, retentionDays },
    ).catch(() => undefined);
  }
}

/**
 * Default-on DB backups: give every managed Postgres cluster + compose DB with
 * a named data volume a nightly schedule when a destination exists (logic in
 * `@swarmy/trpc` `ensureAutoBackups` — idempotent, audited, never overrides a
 * user schedule or an opt-out). Overlap-guarded; best-effort.
 */
let autoRunning = false;
async function runAutoBackups(): Promise<void> {
  if (autoRunning) return;
  autoRunning = true;
  try {
    await ensureAutoBackups({ db: prisma, hub, auth: authRegistry.getAuth() });
  } finally {
    autoRunning = false;
  }
}

export function startBackupScheduler(): () => void {
  let tick = 0;
  const timer = setInterval(() => {
    runDue().catch(() => undefined);
    tick++;
    if (tick % AUTO_BACKUP_EVERY_TICKS === 0) runAutoBackups().catch(() => undefined);
  }, TICK_MS);
  // Nodes reconnect a few seconds after boot — defer the first converge.
  const kickoff = setTimeout(() => runAutoBackups().catch(() => undefined), AUTO_BACKUP_FIRST_RUN_MS);
  return () => {
    clearInterval(timer);
    clearTimeout(kickoff);
  };
}
