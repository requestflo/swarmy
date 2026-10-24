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
import { toStoreView, type ControllerMoveTarget, type ControllerStoreRuntimeStatus, type ControllerStoreView } from './controllerStore.view';

export { LAG_WARN_SECONDS, storeSummary, toStoreView } from './controllerStore.view';
export type { ControllerMoveTarget, ControllerStoreRuntimeStatus, ControllerStoreView } from './controllerStore.view';

/** The dedicated Garage bucket control.db replicates into. */
export const CONTROL_BUCKET = 'swarmy-control';
export const CONTROL_KEY_NAME = 'swarmy-control-litestream';

// ── runtime registration ─────────────────────────────────────────────────────

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

/**
 * The Garage key the running controller replicates with, for the platform-key
 * GC (QA-081): `[]` = it uses none, `null` = can't tell (no runtime in this
 * process, or a runtime too old to report the key) — unknown is never unused.
 */
export async function controllerReplicaKeyIds(): Promise<string[] | null> {
  if (!runtime) return null;
  const s = await runtime.status();
  if (!s.replica || s.replica.kind !== 'garage') return [];
  return s.replica.accessKeyId ? [s.replica.accessKeyId] : null;
}

// ── status view ──────────────────────────────────────────────────────────────

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
