import { z } from 'zod';
import { CommandId } from './primitives';

/** Reusable command preamble (every controller→agent command carries these). */
const cmd = { commandId: CommandId, timeoutMs: z.number().int().positive().optional() };

/**
 * A restic repository reference: the S3-shaped target plus the credentials the
 * agent injects into the restic container env. Credentials are resolved
 * just-in-time by the controller (decrypted from the vault) and never persisted
 * on the node — they ride the already-authenticated WS and become process env.
 */
export const ResticRepo = z.object({
  /** Backup target kind. P1 ships S3-compatible only (`s3`); `node` = local path on the node. */
  kind: z.enum(['s3', 'node']),
  /** restic repository URL, e.g. `s3:https://s3.amazonaws.com/bucket/prefix` or `/srv/backups/prefix`. */
  repo: z.string(),
  /** restic repository encryption password (per-target, generated controller-side). */
  password: z.string(),
  /** S3 endpoint (host) — informational; folded into `repo` for restic. */
  endpoint: z.string().optional(),
  region: z.string().optional(),
  /** S3 credentials, injected as AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY. */
  accessKeyId: z.string().optional(),
  secretAccessKey: z.string().optional(),
});
export type ResticRepo = z.infer<typeof ResticRepo>;

/** Pinned restic image the agent runs as a short-lived sidecar. */
export const DEFAULT_RESTIC_IMAGE = 'restic/restic:0.16.4';

// ── backupVolume ───────────────────────────────────────────────────────────

export const BackupVolumePayload = z.object({
  ...cmd,
  /** Correlates the resulting Snapshot row controller-side. */
  jobId: z.string(),
  repo: ResticRepo,
  /** Docker local volume name to back up (mounted read-only into the restic container). */
  volume: z.string(),
  /** restic tags, e.g. [`org:<id>`, `volume:<name>`]. */
  tags: z.array(z.string()).default([]),
  /**
   * Retention window: after a SUCCESSFUL backup the agent runs
   * `restic forget --keep-within <N>d --prune` scoped to the same tags/host this
   * snapshot used. Absent = keep forever (no prune). Additive — older agents
   * ignore it.
   */
  retentionDays: z.number().int().min(1).max(3650).optional(),
  /** Image override; defaults to {@link DEFAULT_RESTIC_IMAGE}. */
  image: z.string().optional(),
  /**
   * Overlay network the restic sidecar joins so in-cluster repo endpoints
   * (e.g. `swarmy-garage`) resolve. Omitted for external/on-node targets.
   */
  network: z.string().optional(),
});
export const BackupVolumeMsg = z.object({
  type: z.literal('backupVolume'),
  payload: BackupVolumePayload,
});
export type BackupVolumeMsg = z.infer<typeof BackupVolumeMsg>;

// ── restoreVolume ──────────────────────────────────────────────────────────

export const RestoreVolumePayload = z.object({
  ...cmd,
  repo: ResticRepo,
  /** restic snapshot id, or `latest`. */
  snapshotId: z.string().default('latest'),
  /** Docker local volume to restore into (created if missing). */
  targetVolume: z.string(),
  image: z.string().optional(),
  /** Overlay network for in-cluster repo endpoints (see BackupVolumePayload). */
  network: z.string().optional(),
});
export const RestoreVolumeMsg = z.object({
  type: z.literal('restoreVolume'),
  payload: RestoreVolumePayload,
});
export type RestoreVolumeMsg = z.infer<typeof RestoreVolumeMsg>;

// ── listSnapshots ──────────────────────────────────────────────────────────

export const ListSnapshotsPayload = z.object({
  ...cmd,
  repo: ResticRepo,
  /** Optional tag filter (e.g. a single volume). */
  tags: z.array(z.string()).default([]),
  image: z.string().optional(),
  /** Overlay network for in-cluster repo endpoints (see BackupVolumePayload). */
  network: z.string().optional(),
});
export const ListSnapshotsMsg = z.object({
  type: z.literal('listSnapshots'),
  payload: ListSnapshotsPayload,
});
export type ListSnapshotsMsg = z.infer<typeof ListSnapshotsMsg>;

export type BackupVolumePayload = z.infer<typeof BackupVolumePayload>;
export type RestoreVolumePayload = z.infer<typeof RestoreVolumePayload>;
export type ListSnapshotsPayload = z.infer<typeof ListSnapshotsPayload>;

// ── result shapes (carried in CommandResultPayload.result) ───────────────────

/** One restic snapshot as reported by `restic snapshots --json`. */
export const ResticSnapshotInfo = z.object({
  id: z.string(),
  time: z.string(),
  hostname: z.string().optional(),
  tags: z.array(z.string()).default([]),
  paths: z.array(z.string()).default([]),
  sizeBytes: z.number().int().nonnegative().optional(),
});
export type ResticSnapshotInfo = z.infer<typeof ResticSnapshotInfo>;

/**
 * Outcome of the post-backup `restic forget --keep-within --prune` pass.
 * A retention failure never fails the backup (the backup already succeeded);
 * it is reported here instead so the controller can surface + audit it.
 */
export const RetentionOutcome = z.object({
  /** The window that was enforced (`--keep-within <N>d`). */
  retentionDays: z.number().int().positive(),
  /** Snapshots `restic forget` removed (0 = nothing had aged out). */
  snapshotsRemoved: z.number().int().nonnegative(),
  /** Set when forget/prune failed; the backup itself still succeeded. */
  error: z.string().optional(),
});
export type RetentionOutcome = z.infer<typeof RetentionOutcome>;

export const BackupVolumeResult = z.object({
  snapshotId: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  filesNew: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  /** Present only when the payload carried `retentionDays`. */
  retention: RetentionOutcome.optional(),
});
export type BackupVolumeResult = z.infer<typeof BackupVolumeResult>;

export const RestoreVolumeResult = z.object({
  targetVolume: z.string(),
  bytesRestored: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative().optional(),
});
export type RestoreVolumeResult = z.infer<typeof RestoreVolumeResult>;

export const ListSnapshotsResult = z.object({
  snapshots: z.array(ResticSnapshotInfo).default([]),
});
export type ListSnapshotsResult = z.infer<typeof ListSnapshotsResult>;
