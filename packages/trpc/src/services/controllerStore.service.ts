/**
 * Controller store: replication status, turning replication on or off, and
 * "Move controller to…" (resilience P3).
 *
 * The runtime (lease, Litestream, boot report) lives in the controller
 * process (apps/api/src/controller-store). It registers itself here with
 * setControllerStoreRuntime() so tRPC can read its status without importing
 * apps/api.
 *
 * Config flow. The replica target and the boot-fallback bundle must be
 * readable before the DB opens, so they live in a Docker secret
 * (`swarmy_control_store.<ts>`) that is mounted into the controller. Turning
 * replication on (1) mints the Garage bucket and key, or reads an S3
 * BackupTarget, (2) creates a new secret, and (3) asks a manager agent to
 * point the controller at it and float its placement to `node.role ==
 * manager`. Step 3 restarts the controller once (stop-first). The next
 * controller boots, holds the lease, and starts replicating.
 */
import { backupTargets, controllerBackupConfigRepo } from './backups.repo';
import {
  CONTROLLER_STORE_SECRET_FAMILY,
  type ControllerLeaseRecord,
  type ControllerServiceOp,
  type ControllerServiceResult,
} from '@swarmy/core/protocol';
import { decryptSecret } from '@swarmy/core/crypto';
import type { OrgContext } from '../context';
import { commandRejected, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { garageS3Endpoint } from './buckets.service';
import { createBucket, createKey, grantKeyOnBucket, overview as bucketsOverview } from './buckets.service';
import { loadTarget, toResticRepo } from './backups.service';
import { resolveManagerNode } from './dispatch.service';

/** The dedicated Garage bucket control.db replicates into. */
export const CONTROL_BUCKET = 'swarmy-control';
export const CONTROL_KEY_NAME = 'swarmy-control-litestream';

// ── runtime registration ─────────────────────────────────────────────────────

/** What the controller process reports (structurally = ControllerStoreStatus in apps/api). */
export interface ControllerStoreRuntimeStatus {
  role: 'standalone' | 'acquiring' | 'leader' | 'fenced' | 'stopping';
  identity: { taskId: string; nodeId: string; hostname: string; service: string };
  lease: ControllerLeaseRecord | null;
  epoch: number | null;
  leaseAgeMs: number | null;
  waitingFor: string | null;
  replica: null | {
    kind: 'garage' | 'backup-target';
    label: string;
    targetId?: string;
    endpoint: string;
    bucket: string;
    prefix: string;
  };
  replicating: boolean;
  replicationBlocked: string | null;
  litestream: null | {
    running: boolean;
    lastSyncAt: string | null;
    txid: string | null;
    pendingWalBytes: number;
    error: string | null;
    restarts: number;
  };
  bundleConfigured: boolean;
  boot: null | { at: string; decision: { kind: string; reason: string }; outcome: string; durationMs: number };
  dbPath: string;
}

export interface ControllerStoreRuntime {
  status(): Promise<ControllerStoreRuntimeStatus>;
}

let runtime: ControllerStoreRuntime | null = null;

export function setControllerStoreRuntime(r: ControllerStoreRuntime | null): void {
  runtime = r;
}

async function runtimeStatus(): Promise<ControllerStoreRuntimeStatus> {
  if (!runtime) throw commandRejected('the controller store runtime is not running in this process');
  return runtime.status();
}

// ── status view ──────────────────────────────────────────────────────────────

export interface ControllerMoveTarget {
  swarmNodeId: string;
  hostname: string;
  status: string;
  availability: string;
  current: boolean;
  /** Why this manager can't take the controller right now (null = eligible). */
  blocked: string | null;
}

export interface ControllerStoreView {
  role: ControllerStoreRuntimeStatus['role'];
  hostname: string;
  swarmNodeId: string;
  epoch: number | null;
  leaseRenewedAgoSec: number | null;
  waitingFor: string | null;
  mode: 'replicated' | 'local-only';
  target: ControllerStoreRuntimeStatus['replica'];
  replicating: boolean;
  lastReplicatedAt: string | null;
  /** Seconds of writes not yet in the replica (0 = caught up; null = unknown). */
  lagSeconds: number | null;
  pendingBytes: number;
  problem: string | null;
  bundleFallback: boolean;
  boot: { at: string; kind: string; outcome: string; reason: string; durationMs: number } | null;
  /** Expected loss window if this node died now. */
  lossWindow: string;
  managers: ControllerMoveTarget[];
}

/** Pure: turn the runtime status into what the dashboard shows. */
export function toStoreView(s: ControllerStoreRuntimeStatus, managers: ControllerMoveTarget[], now = Date.now()): ControllerStoreView {
  const ls = s.litestream;
  const lastSync = ls?.lastSyncAt ? Date.parse(ls.lastSyncAt) : NaN;
  let lagSeconds: number | null = null;
  if (s.replicating && ls) {
    if ((ls.pendingWalBytes ?? 0) === 0) lagSeconds = 0;
    else if (Number.isFinite(lastSync)) lagSeconds = Math.max(0, Math.round((now - lastSync) / 1000));
  }
  const problem =
    s.role === 'fenced'
      ? 'this controller lost its lease and is shutting down'
      : s.replica && !s.replicating
        ? (s.replicationBlocked ?? (s.role === 'acquiring' ? `waiting for the lease: ${s.waitingFor ?? 'starting'}` : 'replication not running'))
        : (ls?.error ?? null);
  return {
    role: s.role,
    hostname: s.identity.hostname,
    swarmNodeId: s.identity.nodeId,
    epoch: s.epoch,
    leaseRenewedAgoSec: s.leaseAgeMs != null ? Math.round(s.leaseAgeMs / 1000) : null,
    waitingFor: s.waitingFor,
    mode: s.replica ? 'replicated' : 'local-only',
    target: s.replica,
    replicating: s.replicating,
    lastReplicatedAt: ls?.lastSyncAt ?? null,
    lagSeconds,
    pendingBytes: ls?.pendingWalBytes ?? 0,
    problem,
    bundleFallback: s.bundleConfigured,
    boot: s.boot
      ? { at: s.boot.at, kind: s.boot.decision.kind, outcome: s.boot.outcome, reason: s.boot.decision.reason, durationMs: s.boot.durationMs }
      : null,
    lossWindow: s.replica
      ? 'about 1 second of writes (Litestream ships every second); none on a clean move'
      : 'everything since the last controller backup (the store is on this node only)',
    managers,
  };
}

function moveTargets(ctx: OrgContext, current: { nodeId: string; hostname: string }): ControllerMoveTarget[] {
  return ctx.hub
    .nodeInventory(ctx.activeOrgId)
    .filter((n) => n.role === 'manager')
    .map((n) => {
      const isCurrent = n.swarmNodeId === current.nodeId || n.hostname === current.hostname;
      const blocked = isCurrent
        ? 'runs the controller now'
        : n.status !== 'ready'
          ? `node is ${n.status}`
          : n.availability !== 'active'
            ? `node is ${n.availability}`
            : null;
      return { swarmNodeId: n.swarmNodeId, hostname: n.hostname, status: n.status, availability: n.availability, current: isCurrent, blocked };
    })
    .sort((a, b) => Number(b.current) - Number(a.current) || a.hostname.localeCompare(b.hostname));
}

export async function getStoreStatus(ctx: OrgContext): Promise<ControllerStoreView> {
  const s = await runtimeStatus();
  return toStoreView(s, moveTargets(ctx, s.identity));
}

// ── replication on/off ───────────────────────────────────────────────────────

export type ReplicationTargetInput = { kind: 'garage' } | { kind: 'backup-target'; targetId: string };

interface StoreDoc {
  version: 1;
  replica?: {
    kind: 'garage' | 'backup-target';
    label: string;
    targetId?: string;
    endpoint: string;
    bucket: string;
    prefix: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
  bundle?: { label?: string; repo: ReturnType<typeof toResticRepo>; passphrase: string };
}

async function garageReplica(ctx: OrgContext): Promise<NonNullable<StoreDoc['replica']>> {
  const store = await bucketsOverview(ctx);
  if (store.state === 'disabled') throw commandRejected('object storage is off. Enable the replicated store first, then try again.');
  if (store.state === 'unreachable') throw commandRejected(`object store unreachable: ${store.message ?? 'try again shortly'}`);
  const bucket = store.buckets.find((b) => b.name === CONTROL_BUCKET) ?? (await createBucket(ctx, { name: CONTROL_BUCKET }));
  // A fresh key each time: the old one stays valid until its secret is gone.
  const key = await createKey(ctx, CONTROL_KEY_NAME);
  await grantKeyOnBucket(ctx, {
    bucketId: bucket.id,
    accessKeyId: key.accessKeyId,
    permissions: { read: true, write: true, owner: false },
    mode: 'allow',
  });
  return {
    kind: 'garage',
    label: 'Garage (in-swarm)',
    endpoint: garageS3Endpoint(),
    bucket: CONTROL_BUCKET,
    prefix: 'control',
    region: store.region,
    accessKeyId: key.accessKeyId,
    secretAccessKey: key.secretAccessKey,
  };
}

async function backupTargetReplica(ctx: OrgContext, targetId: string): Promise<NonNullable<StoreDoc['replica']>> {
  const row = await loadTarget(ctx, targetId);
  const kind = String(row.kind).toLowerCase();
  if (kind === 'node') throw commandRejected('a node-path target lives on one node; pick an S3 target');
  if (!row.endpoint || !row.credentialRef || !row.secretKeyRef) throw commandRejected('this target has no S3 endpoint or credentials');
  const base = row.prefix ? row.prefix.replace(/^\/+|\/+$/g, '') : '';
  return {
    kind: 'backup-target',
    label: row.name,
    targetId: row.id,
    endpoint: row.endpoint,
    bucket: row.bucket,
    prefix: base ? `${base}/swarmy-control` : 'swarmy-control',
    region: row.region ?? 'us-east-1',
    accessKeyId: decryptSecret(row.credentialRef),
    secretAccessKey: decryptSecret(row.secretKeyRef),
  };
}

/** The controller bundle the boot fallback restores when there is no replica data. */
async function bundleSource(ctx: OrgContext): Promise<StoreDoc['bundle'] | undefined> {
  // Settings + target live in the swarm (swarm-kv, P4 slice 3).
  const cfg = await controllerBackupConfigRepo.find(ctx, ctx.activeOrgId).catch(() => null);
  if (!cfg?.targetId || !cfg.restorePassphraseRef || !cfg.orgId) return undefined;
  const row = await backupTargets(ctx, cfg.orgId).findFirst({ where: { id: cfg.targetId } });
  if (!row || String(row.kind).toLowerCase() === 'node') return undefined; // node paths don't follow the controller
  return { label: row.name, repo: toResticRepo(row as never), passphrase: decryptSecret(cfg.restorePassphraseRef) };
}

async function dispatchController(ctx: OrgContext, service: string, op: ControllerServiceOp): Promise<ControllerServiceResult> {
  const node = await resolveManagerNode(ctx);
  return ctx.hub.dispatch<ControllerServiceResult>(node.id, 'controller.service', { service, op }, { timeoutMs: 30_000 });
}

async function writeStoreSecret(ctx: OrgContext, doc: StoreDoc): Promise<string> {
  const node = await resolveManagerNode(ctx);
  const name = `${CONTROLLER_STORE_SECRET_FAMILY}.${Date.now()}`;
  await ctx.hub.dispatch(node.id, 'secret.create', {
    name,
    dataB64: Buffer.from(JSON.stringify(doc)).toString('base64'),
    labels: { 'swarmy.system': 'true', 'swarmy.secret.family': CONTROLLER_STORE_SECRET_FAMILY },
  });
  return name;
}

export async function enableReplication(
  ctx: OrgContext,
  input: { target: ReplicationTargetInput },
): Promise<{ restarting: boolean; secret: string; target: string }> {
  const s = await runtimeStatus();
  const replica = input.target.kind === 'garage' ? await garageReplica(ctx) : await backupTargetReplica(ctx, input.target.targetId);
  const bundle = await bundleSource(ctx);
  const secret = await writeStoreSecret(ctx, { version: 1, replica, ...(bundle ? { bundle } : {}) });
  const res = await dispatchController(ctx, s.identity.service, { kind: 'configure', storeSecret: secret, placement: 'floating' });
  if (!res.ok) throw commandRejected(`could not update the controller service (${res.reason ?? 'unknown'}); try again`);
  await writeAudit(ctx, {
    action: 'controller.store.replicate',
    targetType: 'controller',
    targetId: s.identity.service,
    metadata: { target: replica.label, bucket: replica.bucket, prefix: replica.prefix, bundleFallback: !!bundle, secret },
  });
  return { restarting: true, secret, target: replica.label };
}

export async function disableReplication(ctx: OrgContext): Promise<{ restarting: boolean; pinnedTo: string }> {
  const s = await runtimeStatus();
  const bundle = await bundleSource(ctx);
  const secret = await writeStoreSecret(ctx, { version: 1, ...(bundle ? { bundle } : {}) });
  const res = await dispatchController(ctx, s.identity.service, {
    kind: 'configure',
    storeSecret: secret,
    placement: 'pinned',
    pinnedHostname: s.identity.hostname,
  });
  if (!res.ok) throw commandRejected(`could not update the controller service (${res.reason ?? 'unknown'}); try again`);
  await writeAudit(ctx, {
    action: 'controller.store.local',
    targetType: 'controller',
    targetId: s.identity.service,
    metadata: { pinnedTo: s.identity.hostname, secret },
  });
  return { restarting: true, pinnedTo: s.identity.hostname };
}

// ── move ─────────────────────────────────────────────────────────────────────

export async function moveController(
  ctx: OrgContext,
  input: { swarmNodeId: string },
): Promise<{ from: string; to: string; restarting: boolean }> {
  const s = await runtimeStatus();
  if (!s.replica) {
    throw commandRejected('the controller store is local to this node. Turn on replication first, or the controller would start empty on the new node.');
  }
  if (!s.replicating) throw commandRejected(`replication is not running (${s.replicationBlocked ?? 'starting'}); wait until it is caught up`);
  const target = moveTargets(ctx, s.identity).find((m) => m.swarmNodeId === input.swarmNodeId);
  if (!target) throw notFound('manager node', input.swarmNodeId);
  if (target.blocked) throw commandRejected(`can't move there: ${target.blocked}`);
  // Audit before the dispatch: once it lands, this controller is on its way out.
  await writeAudit(ctx, {
    action: 'controller.move',
    targetType: 'controller',
    targetId: s.identity.service,
    metadata: { from: s.identity.hostname, to: target.hostname, epoch: s.epoch },
  });
  const res = await dispatchController(ctx, s.identity.service, { kind: 'move', targetNodeId: target.swarmNodeId, fromNodeId: s.identity.nodeId });
  if (!res.ok) throw commandRejected(`could not move the controller (${res.reason ?? 'unknown'}); try again`);
  return { from: s.identity.hostname, to: target.hostname, restarting: true };
}
