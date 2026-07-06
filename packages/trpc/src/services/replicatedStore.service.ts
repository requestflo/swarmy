/**
 * Replicated object store service (epic: volumes-dr, P2 — Layer 3).
 *
 * Manages a swarmy-bundled Garage S3 cluster: one `StorageCluster` per org.
 * Deploy stands up a Garage member on each selected node through the existing
 * `applyStorageNode` dispatch path; status reads the layout/health. Once up, a
 * managed BackupTarget can point restic at the in-swarm endpoint — collapsing
 * "off-node replicated storage" onto the same S3 abstraction as cloud backups.
 *
 * Secrets (RPC secret, admin token, S3 access keys) are encrypted at rest via
 * the vault and only decrypted in-memory when rendering a deployment.
 */
import { decryptSecret, encryptSecret, randomToken } from '@swarmy/core/crypto';
import type { OrgContext } from '../context';
import { mapDispatchError, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { requireOnlineNode, resolveManagerNode } from './dispatch.service';
import {
  DEFAULT_GARAGE_IMAGE,
  GARAGE_S3_PORT,
  type GarageMember,
  type GarageRenderInput,
  renderGarageDeployment,
} from './garage-render';

/** Structural copy of the `applyStorageNode` result (see core protocol/storage). */
interface ApplyStorageNodeResult {
  driver: string;
  serviceId: string;
  layoutApplied: boolean;
}

const DEFAULT_REPLICATION = 3;
const DEFAULT_CAPACITY_GB = 100;
const SERVICE_NAME = 'swarmy-garage';

/**
 * Observed-state label the storage-reconcile worker stamps on the store
 * service (health + per-member resync progress). Keep in sync with
 * `apps/api/src/workers/storage-reconcile.core.ts` (a worker cannot
 * subpath-import an internal trpc module).
 */
export const STORAGE_STATS_LABEL = 'swarmy.storage.stats';

export interface StorageClusterView {
  enabled: boolean;
  driver: 'garage' | 'minio' | 'none';
  replicationFactor: number;
  region: string;
  memberNodeIds: string[];
  /** S3 endpoint other targets can reference once the cluster is up. */
  endpoint: string | null;
  /** Whether S3 access keys exist (never the secret itself). */
  hasAccessKeys: boolean;
  updatedAt: string | null;
}

interface ClusterRow {
  id: string;
  orgId: string;
  driver: string;
  enabled: boolean;
  replicationFactor: number;
  region: string;
  memberNodeIds: unknown;
  rpcSecretRef: string | null;
  adminTokenRef: string | null;
  accessKeyRef: string | null;
  secretKeyRef: string | null;
  layout: unknown;
  updatedAt: Date;
}

// `storageCluster` is added to the Prisma schema as part of this epic (see
// INTEGRATION). Until generated, access via a loose handle to keep typecheck green.
function db(ctx: OrgContext): {
  findUnique(args: unknown): Promise<ClusterRow | null>;
  upsert(args: unknown): Promise<ClusterRow>;
  update(args: unknown): Promise<ClusterRow>;
} {
  return (ctx.db as unknown as { storageCluster: ReturnType<typeof db> }).storageCluster;
}

function members(row: ClusterRow): string[] {
  return Array.isArray(row.memberNodeIds) ? (row.memberNodeIds as string[]) : [];
}

/**
 * Per-member discovery record kept under `layout.nodes` on the StorageCluster
 * row — written back by the storage-reconcile worker once a member's Garage
 * node id is observed (the one-shot `enable()` render filters on it).
 */
export interface LayoutNodeRecord {
  garageNodeId?: string;
  capacityGb?: number;
}

export function layoutNodes(layout: unknown): Record<string, LayoutNodeRecord> {
  if (!layout || typeof layout !== 'object' || Array.isArray(layout)) return {};
  const nodes = (layout as { nodes?: unknown }).nodes;
  if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes)) return {};
  const out: Record<string, LayoutNodeRecord> = {};
  for (const [nodeId, rec] of Object.entries(nodes as Record<string, unknown>)) {
    if (!rec || typeof rec !== 'object') continue;
    const r = rec as { garageNodeId?: unknown; capacityGb?: unknown };
    out[nodeId] = {
      ...(typeof r.garageNodeId === 'string' && r.garageNodeId
        ? { garageNodeId: r.garageNodeId }
        : {}),
      ...(typeof r.capacityGb === 'number' && r.capacityGb > 0 ? { capacityGb: r.capacityGb } : {}),
    };
  }
  return out;
}

function endpointFor(row: ClusterRow): string | null {
  return row.enabled ? `http://${SERVICE_NAME}:${GARAGE_S3_PORT}` : null;
}

function toView(row: ClusterRow | null): StorageClusterView {
  if (!row) {
    return {
      enabled: false,
      driver: 'none',
      replicationFactor: DEFAULT_REPLICATION,
      region: 'swarmy',
      memberNodeIds: [],
      endpoint: null,
      hasAccessKeys: false,
      updatedAt: null,
    };
  }
  return {
    enabled: row.enabled,
    driver: (row.driver.toLowerCase() as StorageClusterView['driver']) ?? 'none',
    replicationFactor: row.replicationFactor,
    region: row.region,
    memberNodeIds: members(row),
    endpoint: endpointFor(row),
    hasAccessKeys: Boolean(row.accessKeyRef && row.secretKeyRef),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function load(ctx: OrgContext): Promise<ClusterRow | null> {
  return db(ctx).findUnique({ where: { orgId: ctx.activeOrgId } });
}

export async function getConfig(ctx: OrgContext): Promise<StorageClusterView> {
  return toView(await load(ctx));
}

/** Build the render input from a row (decrypts secrets just-in-time). */
function renderInput(ctx: OrgContext, row: ClusterRow): GarageRenderInput {
  const recorded = layoutNodes(row.layout);
  const memberList: GarageMember[] = members(row).map((nodeId) => ({
    nodeId,
    rpcHost: SERVICE_NAME,
    capacityGb: recorded[nodeId]?.capacityGb ?? DEFAULT_CAPACITY_GB,
    // Discovered by the storage-reconcile worker; absent before first join.
    ...(recorded[nodeId]?.garageNodeId ? { garageNodeId: recorded[nodeId]?.garageNodeId } : {}),
  }));
  return {
    orgId: ctx.activeOrgId,
    serviceName: SERVICE_NAME,
    region: row.region,
    replicationFactor: row.replicationFactor,
    rpcSecret: row.rpcSecretRef ? decryptSecret(row.rpcSecretRef) : '',
    adminToken: row.adminTokenRef ? decryptSecret(row.adminTokenRef) : '',
    members: memberList,
    image: DEFAULT_GARAGE_IMAGE,
  };
}

export interface SetDriverInput {
  driver: 'garage' | 'none';
  replicationFactor?: number;
  region?: string;
  memberNodeIds?: string[];
}

/** Create/update the cluster config (does not deploy — call `enable`). */
export async function setDriver(
  ctx: OrgContext,
  input: SetDriverInput,
): Promise<StorageClusterView> {
  const existing = await load(ctx);
  const row = await db(ctx).upsert({
    where: { orgId: ctx.activeOrgId },
    create: {
      orgId: ctx.activeOrgId,
      driver: input.driver.toUpperCase(),
      enabled: false,
      replicationFactor: input.replicationFactor ?? DEFAULT_REPLICATION,
      region: input.region ?? 'swarmy',
      memberNodeIds: input.memberNodeIds ?? [],
      rpcSecretRef: encryptSecret(randomToken('grpc')),
      adminTokenRef: encryptSecret(randomToken('gadm')),
      accessKeyRef: null,
      secretKeyRef: null,
      layout: {},
    },
    update: {
      driver: input.driver.toUpperCase(),
      replicationFactor:
        input.replicationFactor ?? existing?.replicationFactor ?? DEFAULT_REPLICATION,
      region: input.region ?? existing?.region ?? 'swarmy',
      memberNodeIds: input.memberNodeIds ?? members(existing as ClusterRow),
    },
  });
  await writeAudit(ctx, {
    action: 'storage.setDriver',
    targetType: 'storageCluster',
    targetId: row.id,
    metadata: { driver: input.driver },
  });
  return toView(row);
}

/** Preview the rendered deployment without dispatching (mirrors ingress previewConfig). */
export async function previewDeployment(ctx: OrgContext) {
  const row = await load(ctx);
  if (!row) throw notFound('storage cluster', ctx.activeOrgId);
  return renderGarageDeployment(renderInput(ctx, row));
}

/** Deploy Garage members to every selected node and mark the cluster enabled. */
export async function enable(ctx: OrgContext): Promise<StorageClusterView> {
  const row = await load(ctx);
  if (!row) throw notFound('storage cluster', ctx.activeOrgId);
  const rendered = renderGarageDeployment(renderInput(ctx, row));

  const nodeIds = members(row);
  if (nodeIds.length === 0) {
    // Fall back to a single manager so a one-node store still works.
    const mgr = await resolveManagerNode(ctx);
    nodeIds.push(mgr.id);
  }

  try {
    for (const nodeId of nodeIds) {
      const node = await requireOnlineNode(ctx, nodeId);
      await ctx.hub.dispatch<ApplyStorageNodeResult>(node.id, 'storage.apply', { rendered });
    }
    const updated = await db(ctx).update({
      where: { orgId: ctx.activeOrgId },
      data: { enabled: true, memberNodeIds: nodeIds },
    });
    await writeAudit(ctx, {
      action: 'storage.enable',
      targetType: 'storageCluster',
      targetId: updated.id,
      metadata: { members: nodeIds },
    });
    return toView(updated);
  } catch (e) {
    throw mapDispatchError(e);
  }
}

export async function disable(ctx: OrgContext): Promise<StorageClusterView> {
  const row = await load(ctx);
  if (!row) return toView(null);
  const updated = await db(ctx).update({
    where: { orgId: ctx.activeOrgId },
    data: { enabled: false },
  });
  await writeAudit(ctx, {
    action: 'storage.disable',
    targetType: 'storageCluster',
    targetId: row.id,
  });
  return toView(updated);
}

/** Cluster health as Garage's admin API reports it (partition sync = resync). */
export interface StorageHealthView {
  status: 'healthy' | 'degraded' | 'unavailable' | string;
  knownNodes: number;
  connectedNodes: number;
  storageNodes: number;
  storageNodesOk: number;
  partitions: number;
  partitionsQuorum: number;
  /** partitionsAllOk / partitions = resync progress after a layout change. */
  partitionsAllOk: number;
}

export interface StorageMemberStatusView {
  nodeId: string;
  online: boolean;
  /** Garage node public key once discovered by the storage-reconcile worker. */
  garageNodeId?: string | null;
  up?: boolean | null;
  draining?: boolean | null;
  dataAvailableBytes?: number | null;
  dataTotalBytes?: number | null;
}

export interface StorageStatusView {
  enabled: boolean;
  driver: string;
  members: StorageMemberStatusView[];
  endpoint: string | null;
  /** Observed by the storage-reconcile worker (stats label); null before its first tick. */
  health?: StorageHealthView | null;
  layoutVersion?: number | null;
  statsAt?: string | null;
}

/** Shape of the `swarmy.storage.stats` label the reconcile worker stamps. */
interface StorageStatsStamp {
  at?: string;
  layoutVersion?: number | null;
  health?: StorageHealthView | null;
  nodes?: Array<{
    garageNodeId?: string;
    nodeId?: string | null;
    up?: boolean;
    draining?: boolean;
    dataAvailableBytes?: number | null;
    dataTotalBytes?: number | null;
  }>;
}

function parseStatsStamp(raw: string | undefined): StorageStatsStamp | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as StorageStatsStamp) : null;
  } catch {
    return null;
  }
}

/**
 * Live status: which members are online (hub registry), plus the health +
 * per-member resync view the storage-reconcile worker stamps on the store
 * service as `swarmy.storage.stats` (Docker-truth, absent before its first tick).
 */
export async function status(ctx: OrgContext): Promise<StorageStatusView> {
  const row = await load(ctx);
  if (!row) return { enabled: false, driver: 'none', members: [], endpoint: null };
  const recorded = layoutNodes(row.layout);
  const storeService = ctx.hub
    .liveInventory(ctx.activeOrgId)
    .services.find((s) => s.name === SERVICE_NAME);
  const stats = parseStatsStamp(storeService?.labels?.[STORAGE_STATS_LABEL]);
  const byGarageId = new Map(
    (stats?.nodes ?? [])
      .filter((n) => typeof n.garageNodeId === 'string')
      .map((n) => [n.garageNodeId as string, n]),
  );
  return {
    enabled: row.enabled,
    driver: row.driver.toLowerCase(),
    members: members(row).map((nodeId) => {
      const garageNodeId = recorded[nodeId]?.garageNodeId ?? null;
      const observed = garageNodeId ? byGarageId.get(garageNodeId) : undefined;
      return {
        nodeId,
        online: ctx.hub.isOnline(nodeId),
        garageNodeId,
        up: observed?.up ?? null,
        draining: observed?.draining ?? null,
        dataAvailableBytes: observed?.dataAvailableBytes ?? null,
        dataTotalBytes: observed?.dataTotalBytes ?? null,
      };
    }),
    endpoint: endpointFor(row),
    health: stats?.health ?? null,
    layoutVersion: stats?.layoutVersion ?? null,
    statsAt: stats?.at ?? null,
  };
}
