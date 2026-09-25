/**
 * Controller-state backup service (data-store epic, P1 — "the VERY IMPORTANT bit").
 *
 * Orchestrates the platform-level (org-independent) backup of the controller's
 * brain: a `VACUUM INTO` snapshot of control.db + the controller's secrets + config +
 * manifest, encrypted with a user-held restore passphrase, stored to a restic
 * `BackupTarget`. Runs controller-side (never on an agent).
 *
 * The settings (`ControllerBackupConfig`) and the target they point at live in
 * the swarm (swarm-kv, plans/epic-docker-native-state.md P4 slice 3), so a
 * controller that lost its volume still knows where its backups are.
 * `ControllerSnapshot` history stays in the controller store.
 */
import {
  decryptSecret,
  encryptSecret,
  passphraseFingerprint,
} from '@swarmy/core/crypto';
import type { ResticRepo } from '@swarmy/core/protocol';
import type { DB } from '@swarmy/db';
import { commandRejected, notFound } from '../errors';
import { dirname } from 'node:path';
import { resolveDbPaths } from '@swarmy/db';
import type { AgentHub } from '../hub/types';
import { exportKvForBundle, importKvFromBundle, stashPendingKv, type KvBundleSection } from './swarm-kv.service';
import { writeAudit } from './audit.service';
import {
  backupTargets,
  NATIVE_TARGET_NAME,
  controllerBackupConfigRepo,
  type ControllerBackupConfigDoc,
  type ControllerBackupConfigRow as ControllerBackupConfigDocRow,
} from './backups.repo';
import { loadControlPlane, snapshotControlPlane } from './controllerBackup.snapshot';
import {
  createAndStoreBundle,
  defaultRunner,
  restoreBundle,
  type ControllerManifest,
  type ControllerSecrets,
  type ResticRunner,
} from './controllerBackup.bundle';

// ── model accessors (defensive until the Prisma additions are pushed) ────────

type ControllerBackupConfigRow = ControllerBackupConfigDocRow;

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
  controllerSnapshot: {
    findFirst(args?: unknown): Promise<ControllerSnapshotRow | null>;
    findMany(args?: unknown): Promise<ControllerSnapshotRow[]>;
    create(args: unknown): Promise<ControllerSnapshotRow>;
    update(args: unknown): Promise<ControllerSnapshotRow>;
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

/**
 * Run state, derived from `ControllerSnapshot` history (the config row stores
 * none): the newest attempt drives the schedule, the newest success is what
 * the UI and the Resilience score call "last run".
 */
export interface ControllerRunState {
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
}

export async function controllerRunState(db: DB): Promise<ControllerRunState> {
  const [attempt, success] = await Promise.all([
    models(db).controllerSnapshot.findFirst({ orderBy: { startedAt: 'desc' }, select: { startedAt: true } }),
    models(db).controllerSnapshot.findFirst({
      where: { status: 'SUCCEEDED' },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    }),
  ]);
  return { lastAttemptAt: attempt?.startedAt ?? null, lastSuccessAt: success?.startedAt ?? null };
}

/** The next scheduled run after the newest attempt; null = never run (due now). */
export function controllerNextRunAt(schedule: string, lastAttemptAt: Date | null): Date | null {
  return lastAttemptAt ? nextRunFrom(schedule, lastAttemptAt) : null;
}

function configView(row: ControllerBackupConfigRow, state: ControllerRunState): ControllerBackupConfigView {
  return {
    enabled: row.enabled,
    targetId: row.targetId,
    schedule: row.schedule,
    retention: { ...DEFAULT_RETENTION, ...((row.retention as object) ?? {}) },
    hasPassphrase: Boolean(row.restorePassphraseRef),
    passphraseHint: row.restorePassphraseHint,
    lastRunAt: state.lastSuccessAt?.toISOString() ?? null,
    nextRunAt: row.enabled ? (controllerNextRunAt(row.schedule, state.lastAttemptAt)?.toISOString() ?? null) : null,
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

/** What the config functions need: the controller store + the hub (the config lives in swarm-kv). */
export interface CbScope {
  db: DB;
  hub: AgentHub;
}

const DEFAULT_CONFIG = (): ControllerBackupConfigDoc => ({
  targetId: null,
  enabled: false,
  schedule: DEFAULT_SCHEDULE,
  retention: DEFAULT_RETENTION,
  restorePassphraseRef: null,
  restorePassphraseHint: null,
});

/**
 * The controller self-backup settings (swarm-kv `ctl-backup/controller`, in the
 * org that owns its target). Absent ⇒ the defaults, not written: reads never
 * grow raft. `orgId` is null until first saved.
 */
export async function getOrCreateConfig(scope: CbScope, preferOrgId?: string | null): Promise<ControllerBackupConfigRow> {
  const existing = await controllerBackupConfigRepo.find(scope, preferOrgId);
  if (existing) return existing;
  const now = new Date(0);
  return { ...DEFAULT_CONFIG(), id: SINGLETON_ID, orgId: null, createdAt: now, updatedAt: now };
}

export async function getConfig(scope: CbScope): Promise<ControllerBackupConfigView> {
  const [row, state] = await Promise.all([getOrCreateConfig(scope), controllerRunState(scope.db)]);
  return configView(row, state);
}

interface AuditCtx {
  db: DB;
  hub: AgentHub;
  activeOrgId: string;
  user?: { id: string } | null;
}

/** Write the settings: into the org already holding them, else the caller's org. */
async function saveConfig(
  ctx: AuditCtx,
  current: ControllerBackupConfigRow,
  patch: Partial<ControllerBackupConfigDoc>,
): Promise<ControllerBackupConfigRow> {
  const { id: _id, orgId, createdAt: _c, updatedAt: _u, ...doc } = current;
  const next: ControllerBackupConfigDoc = { ...doc, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
  return controllerBackupConfigRepo.write(ctx, orgId ?? ctx.activeOrgId, next);
}

/** The configured target, looked up in the org whose swarm holds the settings. */
async function configTarget(scope: CbScope, config: ControllerBackupConfigRow, fallbackOrgId?: string): Promise<BackupTargetRow | null> {
  if (!config.targetId) return null;
  const orgId = config.orgId ?? fallbackOrgId;
  if (!orgId) return null;
  return (await backupTargets(scope, orgId).findFirst({ where: { id: config.targetId } })) as unknown as BackupTargetRow | null;
}

/**
 * The target controller backups use: the configured one, else the org's native
 * Garage destination when it exists. The Upgrade preflight's first backup failed
 * with "no backup target configured" on clusters that had the native target and
 * had simply never opened the controller-backup settings (QA-021). Adopting it
 * is persisted, so the settings page then shows it too.
 */
export async function resolveControllerTarget(
  ctx: AuditCtx,
  config: ControllerBackupConfigRow,
): Promise<{ config: ControllerBackupConfigRow; target: BackupTargetRow | null }> {
  if (config.targetId) return { config, target: await configTarget(ctx, config) };
  const native = (await backupTargets(ctx, ctx.activeOrgId).findFirst({
    where: { orgId: ctx.activeOrgId, name: NATIVE_TARGET_NAME },
  })) as unknown as BackupTargetRow | null;
  if (!native) return { config, target: null };
  const saved = await saveConfig(ctx, config, { targetId: native.id });
  return { config: saved, target: native };
}

/** A backup target was removed: controller backups stop pointing at it (the old FK SetNull). */
export async function clearControllerBackupTarget(ctx: AuditCtx, targetId: string): Promise<void> {
  const current = await controllerBackupConfigRepo.find(ctx, ctx.activeOrgId).catch(() => null);
  if (current?.targetId === targetId) await saveConfig(ctx, current, { targetId: null });
}

export async function setConfig(
  ctx: AuditCtx,
  input: { targetId?: string | null; schedule?: string; enabled?: boolean; retention?: typeof DEFAULT_RETENTION },
): Promise<ControllerBackupConfigView> {
  const current = await getOrCreateConfig(ctx, ctx.activeOrgId);
  if (input.targetId) {
    // The target must live in the same org (swarm) as the settings.
    const target = await backupTargets(ctx, current.orgId ?? ctx.activeOrgId).findFirst({ where: { id: input.targetId } });
    if (!target) throw notFound('backup target', input.targetId);
    if (isNodeKind(target.kind)) throw commandRejected(NODE_TARGET_REFUSAL);
  }
  const row = await saveConfig(ctx, current, {
    targetId: input.targetId === undefined ? undefined : input.targetId,
    schedule: input.schedule,
    enabled: input.enabled,
    retention: input.retention,
  });
  await writeAudit(ctx, {
    action: 'controller.backup.config',
    targetType: 'controllerBackupConfig',
    targetId: SINGLETON_ID,
    metadata: { enabled: row.enabled, schedule: row.schedule, targetId: row.targetId },
  });
  return configView(row, await controllerRunState(ctx.db));
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
  const current = await getOrCreateConfig(ctx, ctx.activeOrgId);
  const fingerprint = passphraseFingerprint(passphrase);
  await saveConfig(ctx, current, {
    restorePassphraseRef: encryptSecret(passphrase),
    restorePassphraseHint: fingerprint,
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

/**
 * restic runs inside the controller container, so a node-path repo would land
 * in that container's ephemeral filesystem — gone on the next restart, and on
 * the very box the backup exists to survive. Controller backups need off-box
 * storage.
 */
export const NODE_TARGET_REFUSAL =
  'Controller backups need an off-box destination (S3-compatible or swarmy object storage). ' +
  'A node path would be written inside the controller container and lost on restart.';

export function isNodeKind(kind: string): boolean {
  return String(kind).toLowerCase() === 'node';
}

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
    dbDriver: 'sqlite',
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
  const resolved = await resolveControllerTarget(ctx, await getOrCreateConfig(ctx));
  const config = resolved.config;
  if (!config.targetId) {
    throw new Error('no backup target configured for controller backups');
  }
  if (!config.restorePassphraseRef) {
    throw new Error('no restore passphrase set — capture one before backing up');
  }
  const target = resolved.target;
  if (!target) throw notFound('backup target', config.targetId);
  if (isNodeKind(target.kind)) throw commandRejected(NODE_TARGET_REFUSAL);
  const passphrase = decryptSecret(config.restorePassphraseRef);

  const snapshot = await models(ctx.db).controllerSnapshot.create({
    data: { targetId: target.id, status: 'RUNNING' },
  });

  try {
    const [manifest, dbSnapshot, swarmKv] = await Promise.all([
      buildManifest(ctx.db),
      snapshotControlPlane(ctx.db),
      bundleSwarmKv(ctx),
    ]);
    const result = await createAndStoreBundle({
      contents: { manifest, dbSnapshot, secrets: gatherSecrets(), swarmKv },
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

// ── restore ────────────────────────────────────────────────────────────────────

export interface RestoreControllerResult {
  manifest: ControllerManifest;
  /** Whether the snapshot was loaded into the live DB. */
  tablesLoaded: boolean;
  /** Whether the bundle's SWARMY_SECRET_KEY matches the running controller's. */
  secretsMatch: boolean;
  /** Non-fatal preflight findings the operator should act on (a vault-key mismatch). */
  warnings: string[];
}

/**
 * Restore the controller's brain from a previously-stored bundle.
 *
 * Pulls the encrypted bundle from the configured restic target, decrypts it with
 * the user-held passphrase (supplied for a disaster restore, or the stored
 * operational copy), and — unless `loadData: false` (preview only) — loads the
 * control.db snapshot back into the live DB via {@link loadControlPlane}.
 *
 * Secrets are NOT hot-swapped: `SWARMY_SECRET_KEY` can't change in a running
 * process, so a key mismatch is surfaced as a warning (existing vault ciphertext
 * only decrypts under the original key — the operator must set it from the bundle
 * and restart). Mirrors the disaster-recovery flow in `controllerBackup.bundle`.
 */
export async function restoreControllerBackup(
  ctx: AuditCtx,
  input: { snapshotId?: string; passphrase?: string; loadData?: boolean } = {},
): Promise<RestoreControllerResult> {
  const resolved = await resolveControllerTarget(ctx, await getOrCreateConfig(ctx));
  const config = resolved.config;
  if (!config.targetId) {
    throw new Error('no backup target configured for controller backups');
  }
  const target = resolved.target;
  if (!target) throw notFound('backup target', config.targetId);

  const passphrase =
    input.passphrase?.trim() ||
    (config.restorePassphraseRef ? decryptSecret(config.restorePassphraseRef) : '');
  if (!passphrase) {
    throw new Error('no restore passphrase available — supply one or capture it first');
  }

  const contents = await restoreBundle({
    repo: toResticRepo(target),
    snapshotId: input.snapshotId,
    passphrase,
  });

  const warnings: string[] = [];
  if (contents.manifest.dbDriver !== 'sqlite') {
    throw new Error(`bundle dbDriver="${String(contents.manifest.dbDriver)}" is not restorable; only SQLite bundles are`);
  }
  const liveKey = process.env.SWARMY_SECRET_KEY ?? '';
  const secretsMatch = Boolean(liveKey) && contents.secrets.SWARMY_SECRET_KEY === liveKey;
  if (!secretsMatch) {
    warnings.push(
      'restored SWARMY_SECRET_KEY differs from the running controller — set it from the bundle and restart before relying on vault-encrypted data',
    );
  }

  let tablesLoaded = false;
  let kvPending: string[] = [];
  if (input.loadData !== false) {
    await loadControlPlane(ctx.db, contents.dbSnapshot);
    tablesLoaded = true;
    // The infra config that lives in the swarm (swarm-kv) goes back too — into
    // a fresh swarm as well. Orgs whose manager isn't connected yet wait in the
    // pending file (drained by the swarm-kv-restore worker).
    if (contents.swarmKv?.orgs.length) {
      const res = await importKvFromBundle(ctx.hub, contents.swarmKv);
      kvPending = res.pending;
      if (kvPending.length) {
        await stashPendingKv(
          { version: 1, orgs: contents.swarmKv.orgs.filter((o) => kvPending.includes(o.orgId)) },
          dirname(resolveDbPaths().control),
        );
        warnings.push(`swarm config for ${kvPending.length} org(s) is queued until their manager agent connects`);
      }
    }
  }

  await writeAudit(ctx, {
    action: 'controller.backup.restore',
    targetType: 'controllerBackupConfig',
    targetId: SINGLETON_ID,
    metadata: {
      snapshotId: input.snapshotId ?? 'latest',
      tablesLoaded,
      secretsMatch,
      warnings,
    },
  });

  return { manifest: contents.manifest, tablesLoaded, secretsMatch, warnings };
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

/**
 * Every org's swarm-kv documents for the bundle. An org whose swarm can't be
 * read right now is left out (and logged) — never recorded as "no config".
 */
async function bundleSwarmKv(scope: CbScope): Promise<KvBundleSection | undefined> {
  const orgIds = (await scope.db.organization.findMany({ select: { id: true } })).map((o) => o.id);
  const { section, skipped } = await exportKvForBundle(scope.hub, orgIds);
  if (skipped.length) console.warn(`[controller-backup] swarm config not bundled for ${skipped.length} unreachable org(s)`);
  return section.orgs.length ? section : undefined;
}

/** Whether a scheduled backup is due now (used by the worker). */
export async function isBackupDue(scope: CbScope, now: Date = new Date()): Promise<boolean> {
  const db = scope.db;
  const config = await getOrCreateConfig(scope);
  if (!config.enabled || !config.targetId || !config.restorePassphraseRef) return false;
  // Derived from history: the snapshot row is written before the run starts,
  // so a run in progress (or one that just failed) waits for the next slot.
  const next = controllerNextRunAt(config.schedule, (await controllerRunState(db)).lastAttemptAt);
  return next == null || next <= now;
}
