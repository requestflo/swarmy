/**
 * Backup scheduler worker (epic: volumes-dr, P2).
 *
 * Every minute: find enabled, non-paused `BackupSchedule`s whose `nextRunAt` is
 * due, dispatch a `runBackup` to a node that hosts the volume (or an online
 * manager), record a `BackupJob` row, then advance `nextRunAt` from the
 * cron-ish interval. Secrets are decrypted just-in-time from the target.
 *
 * Mirrors `metrics-sampler`/`retention`: prisma + the shared gateway hub.
 */
import { prisma } from '@swarmy/db';
import { decryptSecret } from '@swarmy/core/crypto';
import type { BackupVolumeResult, ResticRepo } from '@swarmy/core/protocol';
import { hub, registry } from '../gateway';

const TICK_MS = 60_000;

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
          nextRunAt: Date | null;
        }>
      >;
      update(a: unknown): Promise<unknown>;
    };
    backupJob: { create(a: unknown): Promise<{ id: string }>; update(a: unknown): Promise<unknown> };
    backupTarget: { findUnique(a: unknown): Promise<TargetRow | null> };
    snapshot: { create(a: unknown): Promise<{ id: string }>; update(a: unknown): Promise<unknown> };
  };

  const due = await db.backupSchedule.findMany({
    where: { paused: false, nextRunAt: { lte: now } },
  });

  for (const sched of due) {
    const spec: ScheduleSpec = { every: sched.every, unit: sched.unit as ScheduleSpec['unit'] };
    // Advance first so a slow run doesn't double-fire next tick.
    const next = nextRun(spec, sched.createdAt, now);
    await db.backupSchedule.update({
      where: { id: sched.id },
      data: { lastRunAt: now, nextRunAt: next },
    });

    const target = await db.backupTarget.findUnique({ where: { id: sched.targetId } });
    if (!target) continue;
    const nodeId = await pickNode(sched.orgId, sched.nodeId);
    if (!nodeId) continue;

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

    try {
      const result = await hub.dispatch<BackupVolumeResult>(nodeId, 'backup.run', {
        jobId: snapshot.id,
        repo: toRepo(target),
        volume: sched.volume,
        tags: [`org:${sched.orgId}`, `volume:${sched.volume}`],
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
  }
}

export function startBackupScheduler(): () => void {
  const timer = setInterval(() => {
    runDue().catch(() => undefined);
  }, TICK_MS);
  return () => clearInterval(timer);
}
