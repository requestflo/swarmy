/**
 * DR reconciliation worker (epic: volumes-dr, P2 — restore-on-recovery).
 *
 * Polls node health (Docker truth via the hub heartbeat). When a node that
 * hosted volume snapshots has been offline past a grace window, its volumes are
 * stranded — so we schedule a restore of each volume's latest snapshot onto a
 * healthy node (via the existing restic `backup.restore` dispatch).
 *
 * No DB Node/Service rows are read: dead-node liveness comes from the hub
 * (`isOnline`/`lastSeen`, corroborated by `nodeInfoFor` swarm status, the same
 * source as `nodeInventory(includeOffline)`). Which volumes lived on the dead
 * node comes from each `Snapshot.hostNodeId` (a kept backup column) — the only
 * Docker-independent record of where a volume's data was. Restore targets are
 * connected swarm managers (`hub.managerNodes`).
 *
 * Placement policy lives in the pure `selectRestoreTarget` (unit-tested in
 * @swarmy/trpc reconcile-target.ts).
 */
import { prisma } from '@swarmy/db';
import { decryptSecret } from '@swarmy/core/crypto';
import type { ResticRepo, RestoreVolumeResult } from '@swarmy/core/protocol';
import { backupTargets, resticNetworkFor, selectRestoreTarget, type ReconcileNode } from '@swarmy/trpc';
import { hub } from '../gateway';

const TICK_MS = 30_000;
/** A node must be unreachable this long before we declare it dead and restore. */
const GRACE_MS = 5 * 60_000;

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

function toRepo(t: TargetRow): ResticRepo {
  const prefix = t.prefix ? `/${t.prefix.replace(/^\/+/, '')}` : '';
  const repo =
    t.kind === 'NODE' || t.kind === 'node'
      ? `${t.bucket.replace(/\/+$/, '')}${prefix}`
      : `s3:${(t.endpoint ?? '').replace(/\/+$/, '')}/${t.bucket}${prefix}`;
  return {
    kind: t.kind === 'NODE' || t.kind === 'node' ? 'node' : 's3',
    repo,
    password: decryptSecret(t.resticPasswordRef),
    endpoint: t.endpoint ?? undefined,
    region: t.region ?? undefined,
    accessKeyId: t.credentialRef ? decryptSecret(t.credentialRef) : undefined,
    secretAccessKey: t.secretKeyRef ? decryptSecret(t.secretKeyRef) : undefined,
  };
}

interface SnapshotRow {
  id: string;
  volume: string;
  targetId: string;
  resticId: string | null;
  hostNodeId: string | null;
}

interface ReconcileDb {
  restoreOperation: {
    findFirst(a: unknown): Promise<{ id: string } | null>;
    create(a: unknown): Promise<{ id: string }>;
    update(a: unknown): Promise<unknown>;
  };
  snapshot: {
    findMany<T = SnapshotRow>(a: unknown): Promise<T[]>;
  };
}

/** Is a node that hosted snapshots now dead (offline past grace, per Docker truth)? */
function isDead(nodeId: string, now: number): boolean {
  if (hub.isOnline(nodeId)) return false;
  const seen = hub.lastSeen(nodeId);
  if (seen == null || now - seen <= GRACE_MS) return false;
  // Corroborate with swarm status: a node the cluster still reports `ready` isn't dead.
  const info = hub.nodeInfoFor(nodeId);
  return !info || info.status !== 'ready';
}

async function reconcileOrg(orgId: string): Promise<void> {
  // Restore targets = connected swarm managers (Docker truth). Nowhere healthy
  // to land a restore ⇒ nothing to do this tick.
  const candidates: ReconcileNode[] = hub.managerNodes(orgId).map((id) => ({
    id,
    role: 'MANAGER',
    online: true,
    assignedRestores: 0,
  }));
  if (candidates.length === 0) return;

  const db = prisma as unknown as ReconcileDb;

  // Nodes that ever hosted a successful snapshot for this org. Each volume's data
  // last lived on its snapshot's `hostNodeId`; a dead one means stranded volumes.
  const hosts = await db.snapshot.findMany<{ hostNodeId: string | null }>({
    where: { orgId, status: 'SUCCEEDED', hostNodeId: { not: null } },
    select: { hostNodeId: true },
    distinct: ['hostNodeId'],
  });
  const now = Date.now();
  const deadNodeIds = [
    ...new Set(hosts.map((h) => h.hostNodeId).filter((id): id is string => id != null)),
  ].filter((id) => isDead(id, now));
  if (deadNodeIds.length === 0) return;

  for (const deadNodeId of deadNodeIds) {
    // Latest successful snapshot per volume that was hosted on the dead node.
    const snaps = await db.snapshot.findMany({
      where: { orgId, hostNodeId: deadNodeId, status: 'SUCCEEDED' },
      orderBy: { startedAt: 'desc' },
    });
    const handled = new Set<string>();
    for (const snap of snaps) {
      if (handled.has(snap.volume)) continue; // only the newest snapshot per volume
      handled.add(snap.volume);

      // Skip if a reconcile restore is already queued/running for this snapshot.
      const inFlight = await db.restoreOperation.findFirst({
        where: { orgId, snapshotId: snap.id, status: { in: ['QUEUED', 'RUNNING'] } },
      });
      if (inFlight) continue;

      const targetNodeId = selectRestoreTarget({ deadNodeId, nodes: candidates });
      if (!targetNodeId) continue;
      // Targets live in the org's swarm (swarm-kv).
      const target = (await backupTargets({ db: prisma, hub }, orgId).findFirst({
        where: { id: snap.targetId },
      })) as unknown as TargetRow | null;
      if (!target) continue;

      const op = await db.restoreOperation.create({
        data: {
          orgId,
          snapshotId: snap.id,
          targetVolume: snap.volume,
          targetNodeId,
          conflict: 'overwrite',
          status: 'RUNNING',
          reason: 'node-recovery',
          startedAt: new Date(),
        },
      });
      // Count this assignment so the next volume balances onto another manager.
      const rn = candidates.find((n) => n.id === targetNodeId);
      if (rn) rn.assignedRestores += 1;

      try {
        const result = await hub.dispatch<RestoreVolumeResult>(targetNodeId, 'backup.restore', {
          repo: toRepo(target),
          snapshotId: snap.resticId ?? 'latest',
          targetVolume: snap.volume,
          network: resticNetworkFor(target.endpoint),
        });
        await db.restoreOperation.update({
          where: { id: op.id },
          data: {
            status: 'SUCCEEDED',
            bytesRestored: BigInt(result.bytesRestored),
            finishedAt: new Date(),
          },
        });
      } catch (e) {
        await db.restoreOperation.update({
          where: { id: op.id },
          data: { status: 'FAILED', error: e instanceof Error ? e.message : String(e), finishedAt: new Date() },
        });
      }
    }
  }
}

async function tick(): Promise<void> {
  const orgs = await prisma.organization.findMany({ select: { id: true } });
  for (const org of orgs) {
    await reconcileOrg(org.id).catch(() => undefined);
  }
}

export function startDrReconcile(): () => void {
  const timer = setInterval(() => {
    tick().catch(() => undefined);
  }, TICK_MS);
  return () => clearInterval(timer);
}
