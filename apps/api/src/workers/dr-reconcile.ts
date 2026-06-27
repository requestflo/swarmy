/**
 * DR reconciliation worker (epic: volumes-dr, P2 — restore-on-recovery).
 *
 * Polls node health. When a node has been offline past a grace window, it finds
 * services/volumes stranded on that node and schedules a restore of the latest
 * snapshot onto a healthy node (via the existing restic `backup.restore`
 * dispatch). When a new node comes online, pending restores can target it.
 *
 * Placement policy lives in the pure `selectRestoreTarget` (unit-tested in
 * @swarmy/trpc); a small copy is inlined here since the worker cannot subpath-
 * import an internal trpc module.
 */
import { prisma } from '@swarmy/db';
import { decryptSecret } from '@swarmy/core/crypto';
import type { ResticRepo, RestoreVolumeResult } from '@swarmy/core/protocol';
import { hub, registry } from '../gateway';

const TICK_MS = 30_000;
/** A node must be unreachable this long before we declare it dead and restore. */
const GRACE_MS = 5 * 60_000;

// ── placement (mirror of @swarmy/trpc reconcile-target.ts) ───────────────────
interface ReconcileNode {
  id: string;
  role: 'MANAGER' | 'WORKER';
  online: boolean;
  assignedRestores: number;
}
function selectRestoreTarget(deadNodeId: string, nodes: ReconcileNode[]): string | null {
  const candidates = nodes.filter((n) => n.online && n.id !== deadNodeId);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const rr = (n: ReconcileNode) => (n.role === 'MANAGER' ? 0 : 1);
    if (rr(a) !== rr(b)) return rr(a) - rr(b);
    if (a.assignedRestores !== b.assignedRestores) return a.assignedRestores - b.assignedRestores;
    return a.id < b.id ? -1 : 1;
  });
  return candidates[0]!.id;
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

async function reconcileOrg(orgId: string): Promise<void> {
  const nodes = await prisma.node.findMany({
    where: { orgId },
    select: { id: true, role: true, lastSeenAt: true },
  });
  const now = Date.now();
  const reconcileNodes: ReconcileNode[] = nodes.map((n) => ({
    id: n.id,
    role: n.role === 'MANAGER' ? 'MANAGER' : 'WORKER',
    online: registry.isOnline(n.id),
    assignedRestores: 0,
  }));

  // Dead = offline AND last seen past the grace window.
  const dead = nodes.filter(
    (n) =>
      !registry.isOnline(n.id) &&
      n.lastSeenAt != null &&
      now - n.lastSeenAt.getTime() > GRACE_MS,
  );
  if (dead.length === 0) return;

  const db = prisma as unknown as {
    restoreOperation: {
      findFirst(a: unknown): Promise<{ id: string } | null>;
      create(a: unknown): Promise<{ id: string }>;
      update(a: unknown): Promise<unknown>;
    };
    snapshot: {
      findFirst(a: unknown): Promise<
        | { id: string; volume: string; targetId: string; resticId: string | null }
        | null
      >;
    };
    backupTarget: { findUnique(a: unknown): Promise<TargetRow | null> };
  };

  for (const node of dead) {
    // Volumes stranded on the dead node = distinct volumes with a snapshot whose
    // host was this node and which has no successful restore in flight.
    const services = await prisma.service.findMany({
      where: { orgId, nodeId: node.id },
      select: { id: true, volumes: true },
    });
    const volumes = new Set<string>();
    for (const svc of services) {
      const vols = Array.isArray(svc.volumes) ? (svc.volumes as unknown[]) : [];
      for (const v of vols) {
        const name = typeof v === 'string' ? v : (v as { source?: string; name?: string })?.source ?? (v as { name?: string })?.name;
        if (name) volumes.add(name);
      }
    }

    for (const volume of volumes) {
      // Latest successful snapshot for this volume.
      const snap = await db.snapshot.findFirst({
        where: { orgId, volume, status: 'SUCCEEDED' },
        orderBy: { startedAt: 'desc' },
      });
      if (!snap) continue;

      // Skip if a reconcile restore is already queued/running for this snapshot.
      const inFlight = await db.restoreOperation.findFirst({
        where: { orgId, snapshotId: snap.id, status: { in: ['QUEUED', 'RUNNING'] } },
      });
      if (inFlight) continue;

      const targetNodeId = selectRestoreTarget(node.id, reconcileNodes);
      if (!targetNodeId) continue;
      const target = await db.backupTarget.findUnique({ where: { id: snap.targetId } });
      if (!target) continue;

      const op = await db.restoreOperation.create({
        data: {
          orgId,
          snapshotId: snap.id,
          targetVolume: volume,
          targetNodeId,
          conflict: 'overwrite',
          status: 'RUNNING',
          reason: 'node-recovery',
          startedAt: new Date(),
        },
      });
      // Count this assignment so the next volume balances onto another node.
      const rn = reconcileNodes.find((n) => n.id === targetNodeId);
      if (rn) rn.assignedRestores += 1;

      try {
        const result = await hub.dispatch<RestoreVolumeResult>(targetNodeId, 'backup.restore', {
          repo: toRepo(target),
          snapshotId: snap.resticId ?? 'latest',
          targetVolume: volume,
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
