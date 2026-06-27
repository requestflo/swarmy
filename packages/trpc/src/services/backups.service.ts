/**
 * Backups service (epic: volumes-dr, P1 backup primitive).
 *
 * Org-scoped CRUD for `BackupTarget`s plus per-volume backup / restore / list
 * dispatched to the agent through `ctx.hub`. Secrets (S3 creds + the restic
 * repo password) are encrypted at rest via the vault and only decrypted in
 * memory when building a command. Every mutation is audited.
 */
import {
  decryptSecret,
  encryptSecret,
  randomToken,
} from '@swarmy/core/crypto';
import type {
  BackupVolumeResult,
  ListSnapshotsResult,
  ResticRepo,
  ResticSnapshotInfo,
  RestoreVolumeResult,
} from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { mapDispatchError, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { resolveManagerNode, requireOnlineNode } from './dispatch.service';

export type BackupTargetKind = 's3' | 'node';

export interface BackupTargetView {
  id: string;
  name: string;
  kind: BackupTargetKind;
  endpoint: string | null;
  bucket: string;
  prefix: string | null;
  region: string | null;
  /** True when S3 access credentials are stored — never the secret itself. */
  hasCredentials: boolean;
  enabled: boolean;
  createdAt: string;
}

export interface SnapshotView {
  id: string;
  volume: string;
  targetId: string;
  targetName: string;
  status: string;
  resticId: string | null;
  sizeBytes: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

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
  enabled: boolean;
  createdAt: Date;
}

function toView(row: TargetRow): BackupTargetView {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind === 'node' ? 'node' : 's3',
    endpoint: row.endpoint,
    bucket: row.bucket,
    prefix: row.prefix,
    region: row.region,
    hasCredentials: Boolean(row.credentialRef && row.secretKeyRef),
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Build the restic repo URL from a target row. */
function repoUrl(row: TargetRow): string {
  const prefix = row.prefix ? `/${row.prefix.replace(/^\/+/, '')}` : '';
  if (row.kind === 'node') {
    // local path on the node: bucket carries the base dir.
    return `${row.bucket.replace(/\/+$/, '')}${prefix}`;
  }
  const endpoint = (row.endpoint ?? '').replace(/\/+$/, '');
  return `s3:${endpoint}/${row.bucket}${prefix}`;
}

/** Resolve a target into a ready-to-dispatch ResticRepo (decrypts secrets). */
function toResticRepo(row: TargetRow): ResticRepo {
  return {
    kind: row.kind === 'node' ? 'node' : 's3',
    repo: repoUrl(row),
    password: decryptSecret(row.resticPasswordRef),
    endpoint: row.endpoint ?? undefined,
    region: row.region ?? undefined,
    accessKeyId: row.credentialRef ? decryptSecret(row.credentialRef) : undefined,
    secretAccessKey: row.secretKeyRef ? decryptSecret(row.secretKeyRef) : undefined,
  };
}

async function loadTarget(ctx: OrgContext, id: string): Promise<TargetRow> {
  const row = (await ctx.db.backupTarget.findFirst({
    where: { id, orgId: ctx.activeOrgId },
  })) as unknown as TargetRow | null;
  if (!row) throw notFound('backup target', id);
  return row;
}

function volumeTags(orgId: string, volume: string): string[] {
  return [`org:${orgId}`, `volume:${volume}`];
}

// ── targets ──────────────────────────────────────────────────────────────

export async function listTargets(ctx: OrgContext): Promise<BackupTargetView[]> {
  const rows = (await ctx.db.backupTarget.findMany({
    where: { orgId: ctx.activeOrgId },
    orderBy: { createdAt: 'desc' },
  })) as unknown as TargetRow[];
  return rows.map(toView);
}

export interface AddTargetInput {
  name: string;
  kind: BackupTargetKind;
  endpoint?: string;
  bucket: string;
  prefix?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Optional caller-supplied restic password; otherwise generated. */
  resticPassword?: string;
}

export async function addTarget(
  ctx: OrgContext,
  input: AddTargetInput,
): Promise<BackupTargetView> {
  const password = input.resticPassword?.trim() || randomToken('swr');
  const row = (await ctx.db.backupTarget.create({
    data: {
      orgId: ctx.activeOrgId,
      name: input.name,
      kind: input.kind === 'node' ? 'NODE' : 'S3',
      endpoint: input.endpoint ?? null,
      bucket: input.bucket,
      prefix: input.prefix ?? null,
      region: input.region ?? null,
      credentialRef: input.accessKeyId ? encryptSecret(input.accessKeyId) : null,
      secretKeyRef: input.secretAccessKey ? encryptSecret(input.secretAccessKey) : null,
      resticPasswordRef: encryptSecret(password),
      enabled: true,
    },
  })) as unknown as TargetRow;
  await writeAudit(ctx, {
    action: 'backup.target.add',
    targetType: 'backupTarget',
    targetId: row.id,
    metadata: { name: input.name, kind: input.kind },
  });
  return toView(row);
}

export async function removeTarget(
  ctx: OrgContext,
  id: string,
): Promise<{ id: string; removed: true }> {
  await loadTarget(ctx, id);
  await ctx.db.backupTarget.delete({ where: { id } });
  await writeAudit(ctx, { action: 'backup.target.remove', targetType: 'backupTarget', targetId: id });
  return { id, removed: true };
}

// ── backup / restore / list ────────────────────────────────────────────────

export async function backupVolume(
  ctx: OrgContext,
  input: { targetId: string; volume: string; nodeId?: string },
): Promise<{ snapshotId: string; resticId: string; sizeBytes: string }> {
  const target = await loadTarget(ctx, input.targetId);
  const node = input.nodeId
    ? await requireOnlineNode(ctx, input.nodeId)
    : await resolveManagerNode(ctx);

  const snapshot = await ctx.db.snapshot.create({
    data: {
      orgId: ctx.activeOrgId,
      targetId: target.id,
      volume: input.volume,
      status: 'RUNNING',
      hostNodeId: node.id,
    },
  });

  try {
    const result = await ctx.hub.dispatch<BackupVolumeResult>(node.id, 'backup.run', {
      jobId: snapshot.id,
      repo: toResticRepo(target),
      volume: input.volume,
      tags: volumeTags(ctx.activeOrgId, input.volume),
    });
    await ctx.db.snapshot.update({
      where: { id: snapshot.id },
      data: {
        status: 'SUCCEEDED',
        resticId: result.snapshotId,
        sizeBytes: BigInt(result.sizeBytes),
        finishedAt: new Date(),
      },
    });
    await writeAudit(ctx, {
      action: 'backup.run',
      targetType: 'snapshot',
      targetId: snapshot.id,
      metadata: { volume: input.volume, targetId: target.id, resticId: result.snapshotId },
    });
    return {
      snapshotId: snapshot.id,
      resticId: result.snapshotId,
      sizeBytes: String(result.sizeBytes),
    };
  } catch (e) {
    await ctx.db.snapshot.update({
      where: { id: snapshot.id },
      data: {
        status: 'FAILED',
        error: e instanceof Error ? e.message : String(e),
        finishedAt: new Date(),
      },
    });
    throw mapDispatchError(e);
  }
}

export async function listSnapshots(
  ctx: OrgContext,
  input?: { volume?: string; targetId?: string },
): Promise<SnapshotView[]> {
  const rows = await ctx.db.snapshot.findMany({
    where: {
      orgId: ctx.activeOrgId,
      volume: input?.volume,
      targetId: input?.targetId,
    },
    orderBy: { startedAt: 'desc' },
    take: 100,
    include: { target: { select: { name: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    volume: r.volume,
    targetId: r.targetId,
    targetName: (r as { target?: { name?: string } }).target?.name ?? '',
    status: r.status,
    resticId: r.resticId,
    sizeBytes: r.sizeBytes != null ? r.sizeBytes.toString() : null,
    error: r.error,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
  }));
}

/** Live snapshot list straight from the restic repo (catalog truth). */
export async function listRemoteSnapshots(
  ctx: OrgContext,
  input: { targetId: string; volume?: string },
): Promise<ResticSnapshotInfo[]> {
  const target = await loadTarget(ctx, input.targetId);
  const node = await resolveManagerNode(ctx);
  try {
    const res = await ctx.hub.dispatch<ListSnapshotsResult>(node.id, 'backup.list', {
      repo: toResticRepo(target),
      tags: input.volume ? volumeTags(ctx.activeOrgId, input.volume) : [`org:${ctx.activeOrgId}`],
    });
    return res.snapshots;
  } catch (e) {
    throw mapDispatchError(e);
  }
}

export async function restoreSnapshot(
  ctx: OrgContext,
  input: { snapshotId: string; targetVolume?: string; nodeId?: string },
): Promise<{ targetVolume: string; bytesRestored: string }> {
  const snapshot = await ctx.db.snapshot.findFirst({
    where: { id: input.snapshotId, orgId: ctx.activeOrgId },
  });
  if (!snapshot) throw notFound('snapshot', input.snapshotId);
  const target = await loadTarget(ctx, snapshot.targetId);
  const node = input.nodeId
    ? await requireOnlineNode(ctx, input.nodeId)
    : await resolveManagerNode(ctx, snapshot.hostNodeId);
  const targetVolume = input.targetVolume?.trim() || snapshot.volume;

  try {
    const result = await ctx.hub.dispatch<RestoreVolumeResult>(node.id, 'backup.restore', {
      repo: toResticRepo(target),
      snapshotId: snapshot.resticId ?? 'latest',
      targetVolume,
    });
    await writeAudit(ctx, {
      action: 'backup.restore',
      targetType: 'snapshot',
      targetId: snapshot.id,
      metadata: { targetVolume, bytesRestored: result.bytesRestored },
    });
    return { targetVolume: result.targetVolume, bytesRestored: String(result.bytesRestored) };
  } catch (e) {
    throw mapDispatchError(e);
  }
}
