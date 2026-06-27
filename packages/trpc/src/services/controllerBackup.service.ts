/**
 * Controller-state backup service (data-store epic, P1 — "the VERY IMPORTANT bit").
 *
 * Orchestrates the platform-level (org-independent) backup of the controller's
 * brain: a logical control-plane dump + the controller's secrets + config +
 * manifest, encrypted with a user-held restore passphrase, stored to a restic
 * `BackupTarget`. Runs controller-side (never on an agent).
 *
 * The `ControllerBackupConfig` (singleton) and `ControllerSnapshot` models are
 * added by this epic's INTEGRATION Prisma additions. Until they're pushed, this
 * file accesses them through a defensively-typed accessor (the same pattern the
 * codebase already uses for not-yet-migrated columns, e.g. abac.ts /
 * backups.service.ts), so the package stays type-safe either way.
 */
import {
  decryptSecret,
  encryptSecret,
  passphraseFingerprint,
} from '@swarmy/core/crypto';
import type { ResticRepo } from '@swarmy/core/protocol';
import type { DB } from '@swarmy/db';
import { resolveDbDriver } from '@swarmy/db';
import { notFound } from '../errors';
import { writeAudit } from './audit.service';
import { dumpControlPlane } from './controllerBackup.dump';
import {
  createAndStoreBundle,
  defaultRunner,
  listBundleSnapshots,
  type ControllerManifest,
  type ControllerSecrets,
  type ResticRunner,
} from './controllerBackup.bundle';

// ── model accessors (defensive until the Prisma additions are pushed) ────────

interface ControllerBackupConfigRow {
  id: string;
  targetId: string | null;
  enabled: boolean;
  schedule: string;
  retention: unknown;
  restorePassphraseRef: string | null;
  restorePassphraseHint: string | null;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface BackupTargetRow {
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
  orgId: string;
}

interface ControllerSnapshotRow {
  id: string;
  targetId: string;
  resticSnapshotId: string | null;
  sizeBytes: bigint | null;
  durationMs: number | null;
  manifestJson: unknown;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  error: string | null;
}

interface CbModels {
  controllerBackupConfig: {
    findFirst(args?: unknown): Promise<ControllerBackupConfigRow | null>;
    create(args: unknown): Promise<ControllerBackupConfigRow>;
    update(args: unknown): Promise<ControllerBackupConfigRow>;
  };
  controllerSnapshot: {
    findFirst(args?: unknown): Promise<ControllerSnapshotRow | null>;
    findMany(args?: unknown): Promise<ControllerSnapshotRow[]>;
    create(args: unknown): Promise<ControllerSnapshotRow>;
    update(args: unknown): Promise<ControllerSnapshotRow>;
  };
  backupTarget: {
    findFirst(args?: unknown): Promise<BackupTargetRow | null>;
  };
}

function models(db: DB): CbModels {
  return db as unknown as CbModels;
}

export const SINGLETON_ID = 'controller';
const DEFAULT_SCHEDULE = '0 3 * * *'; // daily at 03:00
const DEFAULT_RETENTION = { keepDaily: 7, keepWeekly: 4, keepMonthly: 3 };

// ── views ────────────────────────────────────────────────────────────────────

export interface ControllerBackupConfigView {
  enabled: boolean;
  targetId: string | null;
  schedule: string;
  retention: typeof DEFAULT_RETENTION;
  /** Whether a restore passphrase has been captured. Never the passphrase. */
  hasPassphrase: boolean;
  passphraseHint: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

export interface ControllerSnapshotView {
  id: string;
  targetId: string;
  resticSnapshotId: string | null;
  sizeBytes: string | null;
  durationMs: number | null;
  status: string;
  manifest: ControllerManifest | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

function configView(row: ControllerBackupConfigRow): ControllerBackupConfigView {
  return {
    enabled: row.enabled,
    targetId: row.targetId,
    schedule: row.schedule,
    retention: { ...DEFAULT_RETENTION, ...((row.retention as object) ?? {}) },
    hasPassphrase: Boolean(row.restorePassphraseRef),
    passphraseHint: row.restorePassphraseHint,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
  };
}

function snapshotView(row: ControllerSnapshotRow): ControllerSnapshotView {
  return {
    id: row.id,
    targetId: row.targetId,
    resticSnapshotId: row.resticSnapshotId,
    sizeBytes: row.sizeBytes != null ? row.sizeBytes.toString() : null,
    durationMs: row.durationMs,
    status: row.status,
    manifest: (row.manifestJson as ControllerManifest | null) ?? null,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    error: row.error,
  };
}

// ── config CRUD ───────────────────────────────────────────────────────────────

export async function getOrCreateConfig(db: DB): Promise<ControllerBackupConfigRow> {
  const existing = await models(db).controllerBackupConfig.findFirst({
    where: { id: SINGLETON_ID },
  });
  if (existing) return existing;
  return models(db).controllerBackupConfig.create({
    data: {
      id: SINGLETON_ID,
      enabled: false,
      schedule: DEFAULT_SCHEDULE,
      retention: DEFAULT_RETENTION,
    },
  });
}

export async function getConfig(db: DB): Promise<ControllerBackupConfigView> {
  return configView(await getOrCreateConfig(db));
}

interface AuditCtx {
  db: DB;
  activeOrgId: string;
  user?: { id: string } | null;
}

export async function setConfig(
  ctx: AuditCtx,
  input: { targetId?: string | null; schedule?: string; enabled?: boolean; retention?: typeof DEFAULT_RETENTION },
): Promise<ControllerBackupConfigView> {
  await getOrCreateConfig(ctx.db);
  if (input.targetId) {
    const target = await models(ctx.db).backupTarget.findFirst({ where: { id: input.targetId } });
    if (!target) throw notFound('backup target', input.targetId);
  }
  const row = await models(ctx.db).controllerBackupConfig.update({
    where: { id: SINGLETON_ID },
    data: {
      targetId: input.targetId === undefined ? undefined : input.targetId,
      schedule: input.schedule,
      enabled: input.enabled,
      retention: input.retention,
    },
  });
  await writeAudit(ctx, {
    action: 'controller.backup.config',
    targetType: 'controllerBackupConfig',
    targetId: SINGLETON_ID,
    metadata: { enabled: row.enabled, schedule: row.schedule, targetId: row.targetId },
  });
  return configView(row);
}

/**
 * Capture (or rotate) the user-held restore passphrase. Stored encrypted with
 * the vault key for *operational* (in-place rollback) restores; disaster restore
 * uses the passphrase directly via the CLI. We also keep a non-secret fingerprint
 * as a hint. The passphrase itself is returned ONCE for the recovery card.
 */
export async function setRestorePassphrase(
  ctx: AuditCtx,
  passphrase: string,
): Promise<{ fingerprint: string }> {
  await getOrCreateConfig(ctx.db);
  const fingerprint = passphraseFingerprint(passphrase);
  await models(ctx.db).controllerBackupConfig.update({
    where: { id: SINGLETON_ID },
    data: {
      restorePassphraseRef: encryptSecret(passphrase),
      restorePassphraseHint: fingerprint,
    },
  });
  await writeAudit(ctx, {
    action: 'controller.backup.passphrase.set',
    targetType: 'controllerBackupConfig',
    targetId: SINGLETON_ID,
    metadata: { fingerprint },
  });
  return { fingerprint };
}

// ── repo resolution ───────────────────────────────────────────────────────────

function repoUrl(row: BackupTargetRow): string {
  const prefix = row.prefix ? `/${row.prefix.replace(/^\/+/, '')}` : '';
  if (row.kind === 'NODE' || row.kind === 'node') {
    return `${row.bucket.replace(/\/+$/, '')}${prefix}`;
  }
  const endpoint = (row.endpoint ?? '').replace(/\/+$/, '');
  return `s3:${endpoint}/${row.bucket}${prefix}`;
}

function toResticRepo(row: BackupTargetRow): ResticRepo {
  return {
    kind: row.kind === 'NODE' || row.kind === 'node' ? 'node' : 's3',
    repo: repoUrl(row),
    password: decryptSecret(row.resticPasswordRef),
    endpoint: row.endpoint ?? undefined,
    region: row.region ?? undefined,
    accessKeyId: row.credentialRef ? decryptSecret(row.credentialRef) : undefined,
    secretAccessKey: row.secretKeyRef ? decryptSecret(row.secretKeyRef) : undefined,
  };
}

// ── manifest + secrets gathering ──────────────────────────────────────────────

export async function buildManifest(db: DB): Promise<ControllerManifest> {
  const [orgCount, nodeCount] = await Promise.all([
    db.organization.count(),
    db.node.count(),
  ]);
  return {
    swarmyVersion: process.env.SWARMY_VERSION ?? '0.0.0',
    schemaVersion: process.env.SWARMY_SCHEMA_VERSION ?? '1',
    dbDriver: resolveDbDriver(),
    createdAt: new Date().toISOString(),
    orgCount,
    nodeCount,
    includedTables: 'control-plane',
  };
}

function gatherSecrets(): ControllerSecrets {
  const key = process.env.SWARMY_SECRET_KEY;
  if (!key) {
    throw new Error('SWARMY_SECRET_KEY is not set — cannot build a recoverable controller backup');
  }
  return {
    SWARMY_SECRET_KEY: key,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    config: {
      SWARMY_DB_DRIVER: resolveDbDriver(),
      CONTROLLER_PUBLIC_URL: process.env.CONTROLLER_PUBLIC_URL ?? '',
      ...(process.env.SWARMY_DATA_DIR ? { SWARMY_DATA_DIR: process.env.SWARMY_DATA_DIR } : {}),
    },
  };
}

// ── run a backup now ──────────────────────────────────────────────────────────

export interface RunBackupResult {
  snapshotId: string;
  resticSnapshotId: string;
  sizeBytes: string;
}

export async function runControllerBackup(
  ctx: AuditCtx,
  opts: { runner?: ResticRunner } = {},
): Promise<RunBackupResult> {
  const config = await getOrCreateConfig(ctx.db);
  if (!config.targetId) {
    throw new Error('no backup target configured for controller backups');
  }
  if (!config.restorePassphraseRef) {
    throw new Error('no restore passphrase set — capture one before backing up');
  }
  const target = await models(ctx.db).backupTarget.findFirst({ where: { id: config.targetId } });
  if (!target) throw notFound('backup target', config.targetId);
  const passphrase = decryptSecret(config.restorePassphraseRef);

  const snapshot = await models(ctx.db).controllerSnapshot.create({
    data: { targetId: target.id, status: 'RUNNING' },
  });

  try {
    const [manifest, dump] = await Promise.all([buildManifest(ctx.db), dumpControlPlane(ctx.db)]);
    const result = await createAndStoreBundle({
      contents: { manifest, dbDump: Buffer.from(dump.sql), secrets: gatherSecrets() },
      passphrase,
      repo: toResticRepo(target),
      runner: opts.runner ?? defaultRunner(),
    });
    await models(ctx.db).controllerSnapshot.update({
      where: { id: snapshot.id },
      data: {
        status: 'SUCCEEDED',
        resticSnapshotId: result.resticSnapshotId,
        sizeBytes: BigInt(result.sizeBytes),
        durationMs: result.durationMs,
        manifestJson: manifest as unknown as object,
        finishedAt: new Date(),
      },
    });
    await models(ctx.db).controllerBackupConfig.update({
      where: { id: SINGLETON_ID },
      data: { lastRunAt: new Date(), nextRunAt: nextRunFrom(config.schedule) },
    });
    await writeAudit(ctx, {
      action: 'controller.backup.run',
      targetType: 'controllerSnapshot',
      targetId: snapshot.id,
      metadata: { resticSnapshotId: result.resticSnapshotId, sizeBytes: result.sizeBytes },
    });
    return {
      snapshotId: snapshot.id,
      resticSnapshotId: result.resticSnapshotId,
      sizeBytes: String(result.sizeBytes),
    };
  } catch (e) {
    await models(ctx.db).controllerSnapshot.update({
      where: { id: snapshot.id },
      data: { status: 'FAILED', error: e instanceof Error ? e.message : String(e), finishedAt: new Date() },
    });
    throw e;
  }
}

export async function listSnapshots(db: DB): Promise<ControllerSnapshotView[]> {
  const rows = await models(db).controllerSnapshot.findMany({
    orderBy: { startedAt: 'desc' },
    take: 100,
  });
  return rows.map(snapshotView);
}

/**
 * Restore preview: list the live restic snapshots for the configured target and
 * return the catalog so the UI/CLI can pick one and validate before clobbering.
 */
export async function listRemoteSnapshots(db: DB): Promise<{ id: string; time: string }[]> {
  const config = await getOrCreateConfig(db);
  if (!config.targetId) return [];
  const target = await models(db).backupTarget.findFirst({ where: { id: config.targetId } });
  if (!target) return [];
  const snaps = await listBundleSnapshots(toResticRepo(target));
  return snaps.map((s) => ({ id: s.id, time: s.time }));
}

// ── scheduling ────────────────────────────────────────────────────────────────

/**
 * Compute the next run time. We support the common daily/cron shapes the default
 * uses; for anything more exotic we fall back to "tomorrow at the configured
 * minute/hour". Kept dependency-free (no cron lib) and good enough for a once-a-
 * day controller backup.
 */
export function nextRunFrom(schedule: string, from: Date = new Date()): Date {
  const parts = schedule.trim().split(/\s+/);
  const next = new Date(from);
  next.setSeconds(0, 0);
  if (parts.length === 5) {
    const minute = parts[0] === '*' ? from.getMinutes() : Number(parts[0]);
    const hour = parts[1] === '*' ? from.getHours() : Number(parts[1]);
    next.setMinutes(Number.isFinite(minute) ? minute : 0);
    next.setHours(Number.isFinite(hour) ? hour : 3);
    if (next <= from) next.setDate(next.getDate() + 1);
    return next;
  }
  // default: +24h
  next.setTime(from.getTime() + 24 * 60 * 60 * 1000);
  return next;
}

/** Whether a scheduled backup is due now (used by the worker). */
export async function isBackupDue(db: DB, now: Date = new Date()): Promise<boolean> {
  const config = await getOrCreateConfig(db);
  if (!config.enabled || !config.targetId || !config.restorePassphraseRef) return false;
  if (!config.nextRunAt) return true;
  return config.nextRunAt <= now;
}
