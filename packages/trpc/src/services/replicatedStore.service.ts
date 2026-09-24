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
import { NODE_STORAGE_LABEL, SWARMY_CONTROL_NETWORK } from '@swarmy/core';
import { randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret, randomToken } from '@swarmy/core/crypto';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected, mapDispatchError, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { storageClusterRepo, type StorageClusterDoc, type StorageClusterRow } from './storage-cluster.repo';
import { resolveManagerNode } from './dispatch.service';
import { dispatchNodeLabels } from './node.service';
import { LEGACY_GARAGE_IMAGE } from './garage-admin';
import {
  DEFAULT_GARAGE_IMAGE,
  GARAGE_ADMIN_TOKEN_PREFIX,
  GARAGE_CONFIG_PREFIX,
  GARAGE_MEMBER_NODE_LABEL,
  GARAGE_NETWORK,
  GARAGE_RPC_SECRET_PREFIX,
  GARAGE_S3_PORT,
  GARAGE_SECRET_LABEL,
  effectiveReplicationFactor,
  garageConfigObject,
  garageSecretObjects,
  isGarageSecretName,
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

type ClusterRow = StorageClusterRow;

/** The org's store config (swarm-kv `storage/<orgId>`); null = never configured. */
function db(ctx: OrgContext) {
  return {
    findUnique: (_args?: unknown): Promise<ClusterRow | null> => storageClusterRepo.find(ctx, ctx.activeOrgId),
    update: (args: { where?: unknown; data: Partial<StorageClusterDoc> }): Promise<ClusterRow> =>
      storageClusterRepo.update(ctx, ctx.activeOrgId, args.data),
  };
}

function members(row: ClusterRow | null | undefined): string[] {
  return Array.isArray(row?.memberNodeIds) ? (row!.memberNodeIds as string[]) : [];
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

/**
 * Layout capacity for a member, from the node's real filesystem: 80% of its
 * disk (headroom for the OS, images and other volumes), at least 1 GB. Falls
 * back to the default only when the node hasn't reported stats yet. A fixed
 * 100 GB claim on a 25 GB droplet let Garage plan storage it could never hold.
 */
export function garageCapacityGb(fsTotalBytes: number | null | undefined): number {
  if (!fsTotalBytes || fsTotalBytes <= 0) return DEFAULT_CAPACITY_GB;
  return Math.max(1, Math.floor((fsTotalBytes * 0.8) / 1_000_000_000));
}

/** Build the render input from a row (decrypts secrets just-in-time). */
function renderInput(ctx: OrgContext, row: ClusterRow): GarageRenderInput {
  const recorded = layoutNodes(row.layout);
  const memberList: GarageMember[] = members(row).map((nodeId) => ({
    nodeId,
    rpcHost: SERVICE_NAME,
    capacityGb: recorded[nodeId]?.capacityGb ?? garageCapacityGb(ctx.hub.latestNodeStats?.(nodeId)?.fsTotalBytes),
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
    // The engine this store RUNS — never the newest default (see DEFAULT_GARAGE_IMAGE).
    image: row.engineImage ?? LEGACY_GARAGE_IMAGE,
  };
}

/** Garage requires `rpc_secret` to be exactly 32 bytes, hex-encoded. */
export function garageRpcSecret(): string {
  return randomBytes(32).toString('hex');
}

export function isValidGarageRpcSecret(secret: string): boolean {
  return /^[0-9a-f]{64}$/i.test(secret);
}

/**
 * Rows created before the secret was generated correctly hold a prefixed token
 * Garage refuses to boot with. Such a cluster never started, so rotating the
 * secret is safe; persist it so every member renders the same value.
 */
async function withValidRpcSecret<T extends { rpcSecretRef: string | null }>(ctx: OrgContext, row: T): Promise<T> {
  const current = row.rpcSecretRef ? decryptSecret(row.rpcSecretRef) : '';
  if (isValidGarageRpcSecret(current)) return row;
  const rpcSecretRef = encryptSecret(garageRpcSecret());
  await db(ctx).update({ where: { orgId: ctx.activeOrgId }, data: { rpcSecretRef } });
  return { ...row, rpcSecretRef };
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
  const driver = input.driver.toUpperCase() as StorageClusterDoc['driver'];
  const row = existing
    ? await storageClusterRepo.update(ctx, ctx.activeOrgId, {
        driver,
        replicationFactor: input.replicationFactor ?? existing.replicationFactor ?? DEFAULT_REPLICATION,
        region: input.region ?? existing.region ?? 'swarmy',
        memberNodeIds: input.memberNodeIds ?? members(existing),
      })
    : await storageClusterRepo.update(ctx, ctx.activeOrgId, {
        driver,
        enabled: false,
        replicationFactor: input.replicationFactor ?? DEFAULT_REPLICATION,
        region: input.region ?? 'swarmy',
        memberNodeIds: input.memberNodeIds ?? [],
        rpcSecretRef: encryptSecret(garageRpcSecret()),
        adminTokenRef: encryptSecret(randomToken('gadm')),
        // A brand-new store starts on the current engine.
        engineImage: DEFAULT_GARAGE_IMAGE,
        accessKeyRef: null,
        secretKeyRef: null,
        layout: {},
      });
  await writeAudit(ctx, {
    action: 'storage.setDriver',
    targetType: 'storageCluster',
    targetId: row.id,
    metadata: { driver: input.driver },
  });
  return toView(row);
}

/** One enrolled node as seen for default-membership selection. */
export interface MemberCandidate {
  id: string;
  online: boolean;
  /** Has a Docker swarm node id (i.e. is an active swarm member we can pin to). */
  inSwarm: boolean;
  /** Carries `swarmy.node.storage=true` (WS7 storage role). */
  storageRole: boolean;
}

/**
 * Default Garage members when none were chosen explicitly. Pure.
 * Online swarm nodes with the storage role win; otherwise EVERY eligible
 * (online, in-swarm) node — a 2-node swarm gets 2 members, not 1.
 */
export function pickDefaultMembers(candidates: MemberCandidate[]): string[] {
  const eligible = candidates.filter((c) => c.online && c.inSwarm);
  const storage = eligible.filter((c) => c.storageRole);
  return (storage.length > 0 ? storage : eligible).map((c) => c.id);
}

async function memberCandidates(ctx: OrgContext): Promise<MemberCandidate[]> {
  const rows = (await ctx.db.node.findMany({
    where: { orgId: ctx.activeOrgId },
    select: { id: true },
  })) as { id: string }[];
  return rows.map((r) => ({
    id: r.id,
    online: ctx.hub.isOnline(r.id),
    inSwarm: Boolean(ctx.hub.swarmNodeIdFor(r.id)),
    storageRole: ctx.hub.nodeInfoFor(r.id)?.labels?.[NODE_STORAGE_LABEL] === 'true',
  }));
}

/**
 * Pin the store to its members: stamp `swarmy.garage.member=true` on each
 * member's swarm node (the global service is constrained to it) and flip it to
 * `false` on nodes that carry it but are no longer members. Returns the member
 * ids that were stamped.
 */
async function pinMembers(ctx: OrgContext, via: string, nodeIds: string[]): Promise<string[]> {
  const stamped: string[] = [];
  for (const id of nodeIds) {
    if (await dispatchNodeLabels(ctx.hub, ctx.activeOrgId, id, { [GARAGE_MEMBER_NODE_LABEL]: 'true' })) {
      stamped.push(id);
    }
  }
  const memberSwarmIds = new Set(nodeIds.map((id) => ctx.hub.swarmNodeIdFor(id)).filter(Boolean));
  for (const n of ctx.hub.nodeInventory(ctx.activeOrgId, true)) {
    if (n.labels[GARAGE_MEMBER_NODE_LABEL] === 'true' && !memberSwarmIds.has(n.swarmNodeId)) {
      await ctx.hub
        .dispatch(via, 'node.update', {
          swarmNodeId: n.swarmNodeId,
          labels: { [GARAGE_MEMBER_NODE_LABEL]: 'false' },
        })
        .catch(() => undefined);
    }
  }
  return stamped;
}

/** Best-effort removal of superseded `swarmy-garage-config-*` Docker configs. */
async function sweepGarageConfigs(ctx: OrgContext, via: string, keep: string): Promise<void> {
  try {
    const res = await ctx.hub.dispatch<{ configs?: Array<{ name: string }> }>(via, 'config.list', {});
    for (const c of res.configs ?? []) {
      if (c.name.startsWith(`${GARAGE_CONFIG_PREFIX}-`) && c.name !== keep) {
        await ctx.hub.dispatch(via, 'config.remove', { name: c.name }).catch(() => undefined);
      }
    }
  } catch {
    // best-effort — an in-use config refuses removal; retried on the next enable.
  }
}

/** Best-effort removal of superseded store Docker secrets (rpc secret / admin token). */
async function sweepGarageSecrets(ctx: OrgContext, via: string, keep: string[]): Promise<void> {
  try {
    const res = await ctx.hub.dispatch<{ secrets?: Array<{ name: string }> }>(via, 'secret.list', {});
    const keepSet = new Set(keep);
    for (const s of res.secrets ?? []) {
      if (isGarageSecretName(s.name) && !keepSet.has(s.name)) {
        await ctx.hub.dispatch(via, 'secret.remove', { name: s.name }).catch(() => undefined);
      }
    }
  } catch {
    // best-effort — an in-use secret refuses removal; retried on the next enable.
  }
}

/**
 * Deploy the Garage store onto every member node and mark the cluster enabled.
 *
 * One global-mode `swarmy-garage` service, constrained to member-labelled
 * nodes: each member gets exactly one task that stays on its node (meta/data
 * are node-local volumes). `garage.toml` is a content-addressed swarm Docker
 * config — zero host files. The service is swarm-wide, so it is dispatched
 * ONCE through a manager (a worker agent cannot create services).
 *
 * The replication factor is clamped to the member count (factor 3 on 2 nodes
 * never becomes healthy) and the clamped value is persisted so the view is
 * truthful.
 */
export async function enable(ctx: OrgContext): Promise<StorageClusterView> {
  const loaded = await load(ctx);
  if (!loaded) throw notFound('storage cluster', ctx.activeOrgId);
  const row = await withValidRpcSecret(ctx, loaded);

  const nodeIds = members(row).length > 0 ? [...members(row)] : pickDefaultMembers(await memberCandidates(ctx));
  if (nodeIds.length === 0) {
    throw commandRejected('No online swarm node is available to host the object store.');
  }
  const replicationFactor = effectiveReplicationFactor(row.replicationFactor, nodeIds.length);
  const input = renderInput(ctx, { ...row, memberNodeIds: nodeIds, replicationFactor });
  const rendered = renderGarageDeployment(input);
  const config = garageConfigObject(input);
  const secrets = Object.values(garageSecretObjects(input));

  try {
    const mgr = await resolveManagerNode(ctx);
    const pinned = await pinMembers(ctx, mgr.id, nodeIds);
    if (pinned.length === 0) {
      throw commandRejected(
        'Could not pin the object store to any member node (no member has reported its swarm node id yet).',
      );
    }
    // The store is overlay-only (no published ports): make sure the shared
    // attachable overlay exists before the service references it.
    await ctx.hub.dispatch(mgr.id, 'network.ensure', {
      name: GARAGE_NETWORK,
      driver: 'overlay',
      attachable: true,
      labels: { 'swarmy.managed': 'true' },
    });
    // Secrets first: `garage.toml` only references them (`*_file` keys) — the
    // rpc secret / admin token never ride in a (world-inspectable) config.
    for (const secret of secrets) {
      try {
        await ctx.hub.dispatch(mgr.id, 'secret.create', {
          name: secret.name,
          dataB64: Buffer.from(secret.value, 'utf8').toString('base64'),
          labels: { 'swarmy.managed': 'true', 'swarmy.component': 'storage', [GARAGE_SECRET_LABEL]: 'true' },
        });
      } catch (e) {
        // Content-addressed ⇒ an existing secret of this name holds these bytes.
        if (!/already exists|conflict/i.test(e instanceof Error ? e.message : String(e))) throw e;
      }
    }
    try {
      await ctx.hub.dispatch(mgr.id, 'config.create', {
        name: config.name,
        dataB64: Buffer.from(config.contents, 'utf8').toString('base64'),
        labels: { 'swarmy.managed': 'true', 'swarmy.component': 'storage' },
      });
    } catch (e) {
      if (!/already exists|conflict/i.test(e instanceof Error ? e.message : String(e))) throw e;
    }
    await ctx.hub.dispatch<ApplyStorageNodeResult>(mgr.id, 'storage.apply', { rendered });
    // Superseded configs (incl. legacy ones that embedded the secrets) + secrets.
    await sweepGarageConfigs(ctx, mgr.id, config.name);
    await sweepGarageSecrets(ctx, mgr.id, secrets.map((s) => s.name));

    const updated = await db(ctx).update({
      where: { orgId: ctx.activeOrgId },
      data: { enabled: true, memberNodeIds: nodeIds, replicationFactor },
    });
    await writeAudit(ctx, {
      action: 'storage.enable',
      targetType: 'storageCluster',
      targetId: updated.id,
      metadata: {
        members: nodeIds,
        replicationFactor,
        ...(replicationFactor !== row.replicationFactor
          ? { requestedReplicationFactor: row.replicationFactor }
          : {}),
      },
    });
    return toView(updated);
  } catch (e) {
    throw mapDispatchError(e);
  }
}

/**
 * Whether the live store service predates the current shape and must be
 * redeployed: missing, still bind-mounting a host `garage.toml`, not mounting a
 * `swarmy-garage-config-*` Docker config, not global-mode (one pinned task per
 * member), NOT on the swarmy overlay, still publishing any port on the
 * routing mesh (managed data is private-only), or not mounting the rpc-secret
 * + admin-token Docker SECRETS (a legacy render embedded both in the
 * `garage.toml` config — secret-in-config installs migrate here). Pure.
 */
export function storeNeedsConverge(
  svc:
    | (Pick<SwarmServiceInfo, 'mode' | 'configs' | 'mounts'> &
        Partial<Pick<SwarmServiceInfo, 'networks' | 'ports' | 'secrets'>>)
    | undefined,
): boolean {
  if (!svc) return true;
  if ((svc.mounts ?? []).some((m) => m.type === 'bind')) return true;
  if (!(svc.configs ?? []).some((n) => n.startsWith(`${GARAGE_CONFIG_PREFIX}-`))) return true;
  if (!(svc.networks ?? []).some((n) => n.name === GARAGE_NETWORK)) return true;
  // The controller replicates control.db into Garage over the control overlay.
  if (!(svc.networks ?? []).some((n) => n.name === SWARMY_CONTROL_NETWORK)) return true;
  if ((svc.ports ?? []).length > 0) return true;
  const secrets = svc.secrets ?? [];
  if (!secrets.some((n) => n.startsWith(`${GARAGE_RPC_SECRET_PREFIX}-`))) return true;
  if (!secrets.some((n) => n.startsWith(`${GARAGE_ADMIN_TOKEN_PREFIX}-`))) return true;
  return svc.mode !== 'global';
}

/**
 * Storage-reconcile hook: re-run `enable` for an enabled cluster whose live
 * service is legacy (see {@link storeNeedsConverge}), so installs deployed
 * with the old host-bind / routing-mesh-published spec heal without an
 * operator click. Returns whether
 * a redeploy was attempted.
 */
export async function convergeStoreDeployment(ctx: OrgContext, now = Date.now()): Promise<boolean> {
  const row = await load(ctx);
  if (!row?.enabled || row.driver.toLowerCase() !== 'garage') return false;
  const svc = ctx.hub.liveInventory(ctx.activeOrgId).services.find((s) => s.name === SERVICE_NAME);
  if (!storeNeedsConverge(svc)) return false;
  // Throttle: a converge that cannot take (e.g. an older agent that does not
  // report configs/mounts) must not redeploy + audit every worker tick.
  const last = lastConvergeAt.get(ctx.activeOrgId) ?? 0;
  if (now - last < CONVERGE_COOLDOWN_MS) return false;
  lastConvergeAt.set(ctx.activeOrgId, now);
  await enable(ctx);
  return true;
}

const CONVERGE_COOLDOWN_MS = 10 * 60_000;
const lastConvergeAt = new Map<string, number>();

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
