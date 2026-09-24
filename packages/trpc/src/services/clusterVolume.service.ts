/**
 * Swarm CSI cluster-volume orchestration (epic: volumes-dr, P3 — Layer 2).
 *
 * Opt-in path: register a volume as cluster-scoped against an *existing* CSI
 * plugin (we do NOT ship a driver) and reference it in service mounts. Swarm
 * then republishes the volume when a service reschedules, giving live failover.
 * restic backups still layer on top (availability ≠ recoverability).
 *
 * Docker is the source of truth (epic-docker-native-state P1): the list is
 * `docker volume ls` on a manager (`volume.list`, cluster volumes only), never
 * a table. A volume's id in this API is its name (unique per swarm).
 * `provisionVolume`/`removeVolume` ride the existing command/result plumbing.
 */
import type { ListVolumesResult, VolumeInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected, mapDispatchError, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { requireOnlineNode, resolveManagerNode } from './dispatch.service';

export type VolumeAccessMode = 'single-writer' | 'multi-writer' | 'multi-reader';

/** Structural copies of the core protocol/storage shapes. */
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
  /** The volume name (cluster volume names are unique per swarm). */
  id: string;
  name: string;
  csiDriver: string;
  accessMode: VolumeAccessMode;
  capacityBytes: string | null;
  /** Docker's publish state, upper-cased (e.g. READY, PENDING_PUBLISH); READY when unreported. */
  status: string;
  serviceId: string | null;
  createdAt: string;
}

/** A listing is a local read on the manager: fail fast (an older agent never answers). */
const LIST_TIMEOUT_MS = 10_000;

function toView(v: VolumeInfo): ClusterVolumeView {
  return {
    id: v.name,
    name: v.name,
    csiDriver: v.driver,
    accessMode: v.cluster?.accessMode ?? 'single-writer',
    capacityBytes: v.cluster?.capacityBytes != null ? String(v.cluster.capacityBytes) : null,
    status: (v.cluster?.state ?? 'ready').toUpperCase().replace(/[^A-Z]+/g, '_'),
    serviceId: null,
    createdAt: v.createdAt ?? '',
  };
}

/** Mount entry to splice into a ServiceSpec for a cluster volume. */
export function clusterMount(name: string, target: string, readOnly = false) {
  return { type: 'volume' as const, source: name, target, readOnly };
}

/** Live cluster volumes, read from a manager. Throws when no manager answers. */
async function liveClusterVolumes(ctx: OrgContext): Promise<VolumeInfo[]> {
  const node = await resolveManagerNode(ctx);
  try {
    const res = await ctx.hub.dispatch<ListVolumesResult>(
      node.id,
      'volume.list',
      { cluster: true },
      { timeoutMs: LIST_TIMEOUT_MS },
    );
    return (res.volumes ?? []).filter((v) => v.cluster);
  } catch (e) {
    throw mapDispatchError(e);
  }
}

export async function list(ctx: OrgContext): Promise<ClusterVolumeView[]> {
  const vols = await liveClusterVolumes(ctx);
  return vols.map(toView).sort((a, b) => a.name.localeCompare(b.name));
}

/** How many cluster volumes exist (0 when no manager answers). */
export async function count(ctx: OrgContext): Promise<number> {
  return liveClusterVolumes(ctx).then(
    (v) => v.length,
    () => 0,
  );
}

export interface RegisterInput {
  name: string;
  csiDriver: string;
  accessMode?: VolumeAccessMode;
  capacityBytes?: number;
  options?: Record<string, string>;
  /** Accepted for API compatibility; the binding lives in the service's mount spec. */
  serviceId?: string;
}

/**
 * Provision a cluster volume. Cluster volumes work only with Swarm services
 * and require the CSI plugin on the manager nodes — we dispatch the create to
 * a manager. Nothing is recorded: the next list reads it back from Docker.
 */
export async function register(ctx: OrgContext, input: RegisterInput): Promise<ClusterVolumeView> {
  if (!input.csiDriver.trim()) throw commandRejected('a CSI driver is required for cluster volumes');
  const accessMode = input.accessMode ?? 'single-writer';
  const spec: VolumeSpec = {
    name: input.name,
    mode: 'cluster',
    csiDriver: input.csiDriver,
    accessMode,
    capacityBytes: input.capacityBytes,
    options: input.options ?? {},
  };
  try {
    const node = await resolveManagerNode(ctx);
    await ctx.hub.dispatch<ProvisionVolumeResult>(node.id, 'volume.provision', { spec });
  } catch (e) {
    throw mapDispatchError(e);
  }
  await writeAudit(ctx, {
    action: 'volume.cluster.register',
    targetType: 'clusterVolume',
    targetId: input.name,
    metadata: { name: input.name, csiDriver: input.csiDriver },
  });
  const live = await liveClusterVolumes(ctx).catch(() => [] as VolumeInfo[]);
  const found = live.find((v) => v.name === input.name);
  return found
    ? toView(found)
    : {
        id: input.name,
        name: input.name,
        csiDriver: input.csiDriver,
        accessMode,
        capacityBytes: input.capacityBytes != null ? String(input.capacityBytes) : null,
        status: 'PROVISIONING',
        serviceId: null,
        createdAt: new Date().toISOString(),
      };
}

export async function deregister(ctx: OrgContext, id: string): Promise<{ id: string; removed: true }> {
  const live = await liveClusterVolumes(ctx);
  if (!live.some((v) => v.name === id)) throw notFound('cluster volume', id);
  const node = await resolveManagerNode(ctx);
  await requireOnlineNode(ctx, node.id);
  try {
    await ctx.hub.dispatch(node.id, 'volume.remove', { name: id, cluster: true });
  } catch (e) {
    throw mapDispatchError(e);
  }
  await writeAudit(ctx, {
    action: 'volume.cluster.deregister',
    targetType: 'clusterVolume',
    targetId: id,
  });
  return { id, removed: true };
}
