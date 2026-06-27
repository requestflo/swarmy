/**
 * Swarm CSI cluster-volume orchestration (epic: volumes-dr, P3 — Layer 2).
 *
 * Opt-in path: register a volume as cluster-scoped against an *existing* CSI
 * plugin (we do NOT ship a driver) and reference it in service mounts. Swarm
 * then republishes the volume when a service reschedules, giving live failover.
 * restic backups still layer on top (availability ≠ recoverability).
 *
 * One `ClusterVolume` row per org/name. `provisionVolume`/`removeVolume` ride
 * the existing command/result plumbing.
 */
import type { OrgContext } from '../context';
import { commandRejected, mapDispatchError, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { requireOnlineNode, resolveManagerNode } from './dispatch.service';

export type VolumeAccessMode = 'single-writer' | 'multi-writer' | 'multi-reader';

/** Structural copies of the new core protocol/storage shapes (see INTEGRATION). */
interface VolumeSpec {
  name: string;
  mode: 'local' | 'cluster';
  csiDriver?: string;
  accessMode: VolumeAccessMode;
  capacityBytes?: number;
  options: Record<string, string>;
}
interface ProvisionVolumeResult {
  name: string;
  mode: 'local' | 'cluster';
  created: boolean;
}

export interface ClusterVolumeView {
  id: string;
  name: string;
  csiDriver: string;
  accessMode: VolumeAccessMode;
  capacityBytes: string | null;
  status: string;
  serviceId: string | null;
  createdAt: string;
}

interface VolumeRow {
  id: string;
  orgId: string;
  name: string;
  csiDriver: string;
  accessMode: string;
  capacityBytes: bigint | null;
  options: unknown;
  status: string;
  serviceId: string | null;
  createdAt: Date;
}

// `clusterVolume` is added to the Prisma schema as part of this epic (see
// INTEGRATION). Loose handle keeps typecheck green before client regen.
function db(ctx: OrgContext): {
  findMany(args: unknown): Promise<VolumeRow[]>;
  findFirst(args: unknown): Promise<VolumeRow | null>;
  create(args: unknown): Promise<VolumeRow>;
  update(args: unknown): Promise<VolumeRow>;
  delete(args: unknown): Promise<VolumeRow>;
} {
  return (ctx.db as unknown as { clusterVolume: ReturnType<typeof db> }).clusterVolume;
}

function toView(row: VolumeRow): ClusterVolumeView {
  return {
    id: row.id,
    name: row.name,
    csiDriver: row.csiDriver,
    accessMode: row.accessMode as VolumeAccessMode,
    capacityBytes: row.capacityBytes != null ? row.capacityBytes.toString() : null,
    status: row.status,
    serviceId: row.serviceId,
    createdAt: row.createdAt.toISOString(),
  };
}

function toSpec(row: VolumeRow): VolumeSpec {
  return {
    name: row.name,
    mode: 'cluster',
    csiDriver: row.csiDriver,
    accessMode: row.accessMode as VolumeAccessMode,
    capacityBytes: row.capacityBytes != null ? Number(row.capacityBytes) : undefined,
    options: (row.options ?? {}) as Record<string, string>,
  };
}

/** Mount entry to splice into a ServiceSpec for a registered cluster volume. */
export function clusterMount(name: string, target: string, readOnly = false) {
  return { type: 'volume' as const, source: name, target, readOnly };
}

export async function list(ctx: OrgContext): Promise<ClusterVolumeView[]> {
  const rows = await db(ctx).findMany({
    where: { orgId: ctx.activeOrgId },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toView);
}

export interface RegisterInput {
  name: string;
  csiDriver: string;
  accessMode?: VolumeAccessMode;
  capacityBytes?: number;
  options?: Record<string, string>;
  /** Optionally bind to a service (recorded for the deploy path). */
  serviceId?: string;
}

/**
 * Register + provision a cluster volume. Cluster volumes work only with Swarm
 * services and require the CSI plugin on the manager nodes — we dispatch the
 * create to a manager.
 */
export async function register(ctx: OrgContext, input: RegisterInput): Promise<ClusterVolumeView> {
  if (!input.csiDriver.trim()) throw commandRejected('a CSI driver is required for cluster volumes');
  const row = await db(ctx).create({
    data: {
      orgId: ctx.activeOrgId,
      name: input.name,
      csiDriver: input.csiDriver,
      accessMode: input.accessMode ?? 'single-writer',
      capacityBytes: input.capacityBytes != null ? BigInt(input.capacityBytes) : null,
      options: input.options ?? {},
      status: 'PROVISIONING',
      serviceId: input.serviceId ?? null,
    },
  });

  try {
    const node = await resolveManagerNode(ctx);
    await ctx.hub.dispatch<ProvisionVolumeResult>(node.id, 'volume.provision', {
      spec: toSpec(row),
    });
    const updated = await db(ctx).update({ where: { id: row.id }, data: { status: 'READY' } });
    await writeAudit(ctx, {
      action: 'volume.cluster.register',
      targetType: 'clusterVolume',
      targetId: row.id,
      metadata: { name: input.name, csiDriver: input.csiDriver },
    });
    return toView(updated);
  } catch (e) {
    await db(ctx).update({ where: { id: row.id }, data: { status: 'FAILED' } });
    throw mapDispatchError(e);
  }
}

export async function deregister(ctx: OrgContext, id: string): Promise<{ id: string; removed: true }> {
  const row = await db(ctx).findFirst({ where: { id, orgId: ctx.activeOrgId } });
  if (!row) throw notFound('cluster volume', id);
  const node = await resolveManagerNode(ctx).catch(() => null);
  if (node) {
    await requireOnlineNode(ctx, node.id).catch(() => null);
    await ctx.hub
      .dispatch(node.id, 'volume.remove', { name: row.name, cluster: true })
      .catch(() => undefined);
  }
  await db(ctx).delete({ where: { id } });
  await writeAudit(ctx, {
    action: 'volume.cluster.deregister',
    targetType: 'clusterVolume',
    targetId: id,
  });
  return { id, removed: true };
}
