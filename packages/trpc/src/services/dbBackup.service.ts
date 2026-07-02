/**
 * DB-aware backup service (epic: data-plane, richer engines).
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
 */
import { decryptSecret, randomToken } from '@swarmy/core/crypto';
import { buildInventory, type InvService } from '@swarmy/core';
import type {
  DbBackupResult,
  DbConnection,
  DbBackupEngine,
  DbRestoreMode,
  DbRestoreResult,
  ListSnapshotsResult,
  ResticRepo,
  ResticSnapshotInfo,
} from '@swarmy/core/protocol';
import { isPhysicalEngine } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected, mapDispatchError, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { resolveManagerNode } from './dispatch.service';
import {
  DB_CLUSTER_LABEL,
  DB_ROLE_LABEL,
  clusterNetworkName,
} from './manageddb.service';

const PG_PORT = 5432;
const DEFAULT_DATABASE = 'app';
const DEFAULT_USER = 'postgres';

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
    primary: members.find((s) => s.labels[DB_ROLE_LABEL] === 'primary'),
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
      targetType: 'dbCluster',
      targetId: `${input.stack}/${input.cluster}`,
      metadata: {
        engine: input.engine,
        targetId: target.id,
        snapshotId: result.snapshotId,
        fromReplica,
      },
    });
    return {
      engine: result.engine,
      snapshotId: result.snapshotId,
      sizeBytes: String(result.sizeBytes),
      databases: result.databases,
    };
  } catch (e) {
    throw mapDispatchError(e);
  }
}

// ── list ────────────────────────────────────────────────────────────────────

export async function listDbBackups(
  ctx: OrgContext,
  input: { targetId: string; stack?: string; cluster?: string },
): Promise<ResticSnapshotInfo[]> {
  const target = await loadTarget(ctx, input.targetId);
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
    return res.snapshots;
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
  targetId: string;
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
  const target = await loadTarget(ctx, input.targetId);
  const destStack = input.targetStack ?? input.stack;
  const destCluster = input.targetCluster ?? input.cluster;
  const { primary } = findCluster(ctx, destStack, destCluster);
  if (!primary) throw notFound('db cluster primary', destCluster);
  if (input.mode === 'pitr' && !input.dataVolume) {
    throw commandRejected('pitr restore requires the target PGDATA volume (dataVolume)');
  }

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

/**
 * Run any due scheduled DB backups (schedule = `swarmy.db.backup.schedule`
 * label on the cluster primary). Called from the managed-db reconcile worker.
 *
 * Spine stub — slice A1 replaces this with the real due-ness scan + dispatch.
 */
export async function runDueDbBackups(_now: Date): Promise<void> {}
