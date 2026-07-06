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
import { buildInventory } from '@swarmy/core';
import type {
  BackupVolumeResult,
  ListSnapshotsResult,
  ResticRepo,
  ResticSnapshotInfo,
  RestoreVolumeResult,
  RetentionOutcome,
} from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected, mapDispatchError, notFound } from '../errors';
import { writeAudit } from './audit.service';
import {
  createBucket,
  createKey,
  garageS3Endpoint,
  grantKeyOnBucket,
  overview as bucketsOverview,
} from './buckets.service';
import { resolveManagerNode, requireOnlineNode } from './dispatch.service';
import { listStacks } from './stack.service';

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

/** The shared overlay network every swarmy-managed platform service joins. */
export const SWARMY_OVERLAY_NETWORK = 'swarmy';

/** Hostnames that only resolve on the swarmy overlay (in-cluster endpoints). */
const IN_CLUSTER_HOSTS = new Set(['swarmy-garage']);

/**
 * Overlay network a restic one-shot must join to reach `endpoint`, if any.
 * External S3 endpoints and node-path repos need none; the native Garage
 * target (`http://swarmy-garage:3900`) only resolves on the swarmy overlay.
 */
export function resticNetworkFor(endpoint: string | null | undefined): string | undefined {
  if (!endpoint) return undefined;
  try {
    const url = new URL(endpoint.includes('://') ? endpoint : `http://${endpoint}`);
    return IN_CLUSTER_HOSTS.has(url.hostname) ? SWARMY_OVERLAY_NETWORK : undefined;
  } catch {
    return undefined;
  }
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

// ── retention (stack-level Docker truth) ─────────────────────────────────────

/**
 * Volume-backup retention is a STACK-level policy, stored as Docker truth on
 * the stack's services (`swarmy.backup.retentionDays` — the same
 * label-not-a-column pattern as `swarmy.db.backup.schedule`). Every backup of a
 * `<stack>_*` volume — manual, scheduled, or a cache snapshot — inherits it,
 * and the agent enforces it with `restic forget --keep-within <N>d --prune`
 * after each successful backup.
 */
export const STACK_RETENTION_LABEL = 'swarmy.backup.retentionDays';

/** Parse the label value; anything outside 1..3650 whole days degrades to null. */
export function parseRetentionDays(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 3650) return null;
  return n;
}

/**
 * Resolve the retention window for a volume from live inventory: attribute the
 * volume to the LONGEST stack whose `<stack>_` prefix matches (same
 * disambiguation as `listSnapshots` — stack `shop` must not claim `shop_x`'s
 * volumes), then read the stack's retention label. If a partial stamp left the
 * stack's services disagreeing, the LONGEST window wins (prefer keeping data).
 */
export function stackRetentionFor(
  services: Array<{ stack: string; labels: Record<string, string> }>,
  volume: string,
): number | null {
  const stacks = [...new Set(services.map((s) => s.stack))];
  const stack = stacks
    .filter((name) => volume.startsWith(`${name}_`))
    .sort((a, b) => b.length - a.length)[0];
  if (!stack) return null;
  let best: number | null = null;
  for (const s of services) {
    if (s.stack !== stack) continue;
    const n = parseRetentionDays(s.labels[STACK_RETENTION_LABEL]);
    if (n != null && (best == null || n > best)) best = n;
  }
  return best;
}

/** Live services of the org (inventory truth) for retention resolution. */
function invServices(ctx: OrgContext): Array<{ stack: string; labels: Record<string, string>; name: string }> {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  return buildInventory(services, containers).services;
}

/** The stack's configured retention window, or null (keep forever). */
export function getStackRetention(ctx: OrgContext, stack: string): number | null {
  // Probe with a synthetic `<stack>_x` volume so attribution logic is shared.
  return stackRetentionFor(invServices(ctx), `${stack}_x`);
}

/**
 * Set (or clear, with null) the stack's retention window. Stamped on every
 * service in the stack so the policy survives individual service removal.
 */
export async function setStackRetention(
  ctx: OrgContext,
  input: { stack: string; retentionDays: number | null },
): Promise<{ stack: string; retentionDays: number | null }> {
  const services = invServices(ctx).filter((s) => s.stack === input.stack);
  if (services.length === 0) throw notFound('stack', input.stack);
  const node = await resolveManagerNode(ctx);
  for (const s of services) {
    await ctx.hub.dispatch(node.id, 'service.updateLabels', {
      service: s.name,
      add:
        input.retentionDays != null
          ? { [STACK_RETENTION_LABEL]: String(input.retentionDays) }
          : {},
      removeKeys: input.retentionDays == null ? [STACK_RETENTION_LABEL] : [],
    });
  }
  await writeAudit(ctx, {
    action: 'backup.retention.set',
    actorType: ctx.user ? 'user' : 'system',
    targetType: 'stack',
    targetId: input.stack,
    metadata: { retentionDays: input.retentionDays },
  });
  return { stack: input.stack, retentionDays: input.retentionDays };
}

/**
 * One audit row per prune that actually removed snapshots — retention is a
 * destructive action and must leave a trace. A retention FAILURE is also
 * audited (the backup itself succeeded; the miss must not be silent).
 */
export async function auditRetentionOutcome(
  ctx: OrgContext,
  scope: { targetType: string; targetId: string; volume?: string },
  retention: RetentionOutcome | undefined,
): Promise<void> {
  if (!retention) return;
  if (retention.snapshotsRemoved === 0 && !retention.error) return;
  await writeAudit(ctx, {
    action: retention.error ? 'backup.retention.failed' : 'backup.retention.prune',
    actorType: ctx.user ? 'user' : 'system',
    targetType: scope.targetType,
    targetId: scope.targetId,
    metadata: {
      ...(scope.volume ? { volume: scope.volume } : {}),
      retentionDays: retention.retentionDays,
      snapshotsRemoved: retention.snapshotsRemoved,
      ...(retention.error ? { error: retention.error } : {}),
    },
  });
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

// ── native Garage DR target ─────────────────────────────────────────────────

/** Name of the org's managed backup destination on the replicated store. */
export const NATIVE_TARGET_NAME = 'swarmy-object-storage';
/** Dedicated Garage bucket the native destination writes into. */
export const NATIVE_BUCKET = 'swarmy-backups';

export interface NativeTargetResult {
  target: BackupTargetView;
  bucket: string;
  /** False when the destination already existed (the call is idempotent). */
  created: boolean;
}

/**
 * Find-or-create the native DR destination: a `BackupTarget` pointed at the
 * in-swarm Garage endpoint with a dedicated bucket + bucket-scoped key minted
 * through the Garage admin flow. Idempotent — a second click returns the
 * existing destination. Requires the replicated store to be enabled.
 */
export async function ensureNativeTarget(ctx: OrgContext): Promise<NativeTargetResult> {
  const existing = (await ctx.db.backupTarget.findFirst({
    where: { orgId: ctx.activeOrgId, name: NATIVE_TARGET_NAME },
  })) as unknown as TargetRow | null;
  if (existing) {
    return { target: toView(existing), bucket: existing.bucket, created: false };
  }

  const store = await bucketsOverview(ctx);
  if (store.state === 'disabled') {
    throw commandRejected(
      'object storage is off — enable the replicated store below, then try again',
    );
  }
  if (store.state === 'unreachable') {
    throw commandRejected(`object store unreachable: ${store.message ?? 'try again shortly'}`);
  }

  // Mint (or adopt) the dedicated bucket, then a bucket-scoped key. The key
  // secret exists in memory only until it is encrypted onto the target row.
  const bucket =
    store.buckets.find((b) => b.name === NATIVE_BUCKET) ??
    (await createBucket(ctx, { name: NATIVE_BUCKET }));
  const key = await createKey(ctx, `${NATIVE_TARGET_NAME}-restic`);
  await grantKeyOnBucket(ctx, {
    bucketId: bucket.id,
    accessKeyId: key.accessKeyId,
    permissions: { read: true, write: true, owner: false },
    mode: 'allow',
  });

  let target: BackupTargetView;
  try {
    target = await addTarget(ctx, {
      name: NATIVE_TARGET_NAME,
      kind: 's3',
      endpoint: garageS3Endpoint(),
      bucket: NATIVE_BUCKET,
      prefix: 'restic',
      region: store.region,
      accessKeyId: key.accessKeyId,
      secretAccessKey: key.secretAccessKey,
    });
  } catch (e) {
    // Concurrent double-click: the @@unique([orgId, name]) row won the race —
    // adopt it (the extra minted key is bucket-scoped and harmless).
    const raced = (await ctx.db.backupTarget.findFirst({
      where: { orgId: ctx.activeOrgId, name: NATIVE_TARGET_NAME },
    })) as unknown as TargetRow | null;
    if (!raced) throw e;
    return { target: toView(raced), bucket: raced.bucket, created: false };
  }
  await writeAudit(ctx, {
    action: 'backup.target.native',
    targetType: 'backupTarget',
    targetId: target.id,
    metadata: { bucket: NATIVE_BUCKET, accessKeyId: key.accessKeyId },
  });
  return { target, bucket: NATIVE_BUCKET, created: true };
}

// ── backup / restore / list ────────────────────────────────────────────────

export async function backupVolume(
  ctx: OrgContext,
  input: { targetId: string; volume: string; nodeId?: string; retentionDays?: number },
): Promise<{ snapshotId: string; resticId: string; sizeBytes: string }> {
  const target = await loadTarget(ctx, input.targetId);
  const node = input.nodeId
    ? await requireOnlineNode(ctx, input.nodeId)
    : await resolveManagerNode(ctx);
  // Explicit override wins; otherwise inherit the stack's retention label.
  const retentionDays =
    input.retentionDays ?? stackRetentionFor(invServices(ctx), input.volume) ?? undefined;

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
      retentionDays,
      network: resticNetworkFor(target.endpoint),
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
    await auditRetentionOutcome(
      ctx,
      { targetType: 'snapshot', targetId: snapshot.id, volume: input.volume },
      result.retention,
    );
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
  input?: { volume?: string; targetId?: string; stack?: string },
): Promise<SnapshotView[]> {
  let rows = await ctx.db.snapshot.findMany({
    where: {
      orgId: ctx.activeOrgId,
      // Volumes belong to a stack by name prefix (`<stack>_<volume>`).
      volume:
        input?.volume ?? (input?.stack ? { startsWith: `${input.stack}_` } : undefined),
      targetId: input?.targetId,
    },
    orderBy: { startedAt: 'desc' },
    take: 100,
    include: { target: { select: { name: true } } },
  });
  if (input?.stack && !input.volume) {
    // A bare prefix leaks siblings: stack `shop` would match `shop_x`'s volume
    // `shop_x_data`. Attribute each volume to the LONGEST live stack whose
    // `<stack>_` prefix matches, and keep only ours (unknown prefixes — e.g. a
    // removed sibling — stay with the plain prefix match).
    const stacks = (await listStacks(ctx)).map((s) => s.name);
    const target = input.stack;
    rows = rows.filter((r) => {
      const best = stacks
        .filter((name) => r.volume.startsWith(`${name}_`))
        .sort((a, b) => b.length - a.length)[0];
      return best === undefined || best === target;
    });
  }
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
      network: resticNetworkFor(target.endpoint),
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
      network: resticNetworkFor(target.endpoint),
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
