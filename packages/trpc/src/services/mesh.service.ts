/**
 * Mesh service (epic: zero-trust-networking, MVP). Org-scoped orchestration:
 * pick the driver from `@swarmy/mesh`, provision a node (mint a single-use setup
 * key via the control plane), persist a `MeshPeer`, dispatch `applyMesh` over the
 * existing `AgentHub`, and reconcile peer status. Mirrors `ingress.service.ts`.
 *
 * Secrets: the NetBird control-plane service token is encrypted at rest in
 * `MeshConfig.controlPlane` (vault) and never returned to the client; the setup
 * key it mints is single-use and injected JIT into the dispatched `applyMesh`
 * frame only — never persisted in plaintext.
 */
import {
  provisionNode as provisionNodePkg,
  type DriverControlPlane,
  type MeshConfig as OrgMeshConfig,
  type MeshPeerInfo,
} from '@swarmy/mesh';
import type { ApplyMeshResult } from '@swarmy/core/protocol';
import { decryptSecret, encryptSecret, randomToken } from '@swarmy/core/crypto';
import type { OrgContext } from '../context';
import { writeAudit } from '../services/audit.service';
import { notFound } from '../errors';
import { requireOnlineNode } from './dispatch.service';

/** Controller driver ids ⇄ Prisma `MeshDriver` enum. */
export type MeshDriverId = 'netbird' | 'none';
type MeshDriverEnum = 'NETBIRD' | 'NONE';
const DRIVER_TO_ENUM: Record<MeshDriverId, MeshDriverEnum> = { netbird: 'NETBIRD', none: 'NONE' };

function driverLower(d: string): MeshDriverId {
  return d.toUpperCase() === 'NETBIRD' ? 'netbird' : 'none';
}

export interface MeshConfigView {
  driver: MeshDriverId;
  enabled: boolean;
  managementUrl: string | null;
  controlPlaneMode: 'managed-by-swarmy' | 'external';
  /** Whether a control-plane service token is stored (secret never returned). */
  tokenConfigured: boolean;
  peerCount: number;
  updatedAt: string;
}

export interface MeshPeerView {
  id: string;
  nodeId: string;
  meshIp: string | null;
  status: string;
  lastSeen: string | null;
}

/** Shape persisted in `MeshConfig.controlPlane` (Json). `serviceTokenEnc` is a vault blob. */
interface ControlPlaneSettings {
  mode?: 'managed-by-swarmy' | 'external';
  url?: string;
  /** encrypted */
  serviceTokenEnc?: string;
}

interface ConfigRow {
  driver: string;
  enabled: boolean;
  managementUrl: string | null;
  controlPlane: unknown;
  updatedAt: Date;
}

function readControlPlane(row: ConfigRow): ControlPlaneSettings {
  return (row.controlPlane as ControlPlaneSettings | null) ?? {};
}

async function ensureConfig(ctx: OrgContext): Promise<ConfigRow> {
  return ctx.db.meshConfig.upsert({
    where: { orgId: ctx.activeOrgId },
    create: { orgId: ctx.activeOrgId, driver: 'NONE', enabled: false },
    update: {},
  });
}

/** Build the render-time {@link OrgMeshConfig}, resolving the service token JIT. */
function toOrgConfig(ctx: OrgContext, row: ConfigRow): OrgMeshConfig {
  const cp = readControlPlane(row);
  return {
    driver: driverLower(row.driver),
    enabled: row.enabled,
    orgId: ctx.activeOrgId,
    managementUrl: row.managementUrl ?? cp.url ?? undefined,
    controlPlane: {
      mode: cp.mode ?? 'external',
      url: cp.url,
      serviceToken: cp.serviceTokenEnc ? decryptSecret(cp.serviceTokenEnc) : undefined,
    },
    settings: {},
  };
}

/**
 * The NetBird Admin API binding. MVP keeps the on-controller plumbing minimal: a
 * managed/external NetBird mints setup keys via its API. Until the unified server
 * client lands (see INTEGRATION), we mint a swarmy-side single-use key reference;
 * the real `createSetupKey` swaps to `POST {url}/api/setup-keys` with the token.
 */
function makeControlPlane(config: OrgMeshConfig): DriverControlPlane {
  return {
    async createSetupKey({ nodeId }) {
      // TODO(integration): call NetBird `POST /api/setup-keys` with
      // config.controlPlane.serviceToken. For MVP we mint a one-time opaque key.
      void nodeId;
      return { setupKey: randomToken('nbk') };
    },
    async listPeers(): Promise<MeshPeerInfo[]> {
      return [];
    },
    async revokePeer(): Promise<void> {
      // no-op until the Admin API client is wired (see INTEGRATION).
    },
  };
}

export async function getConfig(ctx: OrgContext): Promise<MeshConfigView> {
  const row = await ensureConfig(ctx);
  const cp = readControlPlane(row);
  const peerCount = await ctx.db.meshPeer.count({ where: { orgId: ctx.activeOrgId } });
  return {
    driver: driverLower(row.driver),
    enabled: row.enabled,
    managementUrl: row.managementUrl,
    controlPlaneMode: cp.mode ?? 'external',
    tokenConfigured: Boolean(cp.serviceTokenEnc),
    peerCount,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function listDrivers(): MeshDriverId[] {
  return ['none', 'netbird'];
}

export async function setDriver(ctx: OrgContext, driver: MeshDriverId): Promise<MeshConfigView> {
  await ensureConfig(ctx);
  await ctx.db.meshConfig.update({
    where: { orgId: ctx.activeOrgId },
    data: { driver: DRIVER_TO_ENUM[driver] },
  });
  await writeAudit(ctx, {
    action: 'mesh.setDriver',
    targetType: 'meshConfig',
    targetId: ctx.activeOrgId,
    metadata: { driver },
  });
  return getConfig(ctx);
}

export async function setEnabled(ctx: OrgContext, enabled: boolean): Promise<MeshConfigView> {
  await ensureConfig(ctx);
  await ctx.db.meshConfig.update({ where: { orgId: ctx.activeOrgId }, data: { enabled } });
  await writeAudit(ctx, {
    action: 'mesh.setEnabled',
    targetType: 'meshConfig',
    targetId: ctx.activeOrgId,
    metadata: { enabled },
  });
  return getConfig(ctx);
}

/** Configure (or clear) the control plane: URL + encrypted service token. */
export async function setControlPlane(
  ctx: OrgContext,
  input:
    | { mode: 'managed-by-swarmy' | 'external'; managementUrl?: string; serviceToken?: string }
    | null,
): Promise<MeshConfigView> {
  const row = await ensureConfig(ctx);
  const prev = readControlPlane(row);
  const next: ControlPlaneSettings | null = input
    ? {
        mode: input.mode,
        url: input.managementUrl ?? prev.url,
        serviceTokenEnc: input.serviceToken ? encryptSecret(input.serviceToken) : prev.serviceTokenEnc,
      }
    : null;
  await ctx.db.meshConfig.update({
    where: { orgId: ctx.activeOrgId },
    data: {
      controlPlane: (next ?? {}) as object,
      managementUrl: input?.managementUrl ?? (input ? row.managementUrl : null),
    },
  });
  await writeAudit(ctx, {
    action: input ? 'mesh.setControlPlane' : 'mesh.clearControlPlane',
    targetType: 'meshConfig',
    targetId: ctx.activeOrgId,
    metadata: { mode: input?.mode ?? null, managementUrl: input?.managementUrl ?? null },
  });
  return getConfig(ctx);
}

export async function listPeers(ctx: OrgContext): Promise<MeshPeerView[]> {
  const peers = await ctx.db.meshPeer.findMany({
    where: { orgId: ctx.activeOrgId },
    orderBy: { createdAt: 'desc' },
  });
  return peers.map((p) => ({
    id: p.id,
    nodeId: p.nodeId,
    meshIp: p.meshIp,
    status: p.status,
    lastSeen: p.lastSeen ? p.lastSeen.toISOString() : null,
  }));
}

/**
 * Enroll a node: provision (mint setup key) → persist `MeshPeer` → dispatch
 * `applyMesh` to the node agent. Org-scoped + audited.
 */
export async function enrollNode(
  ctx: OrgContext,
  input: { nodeId: string; advertiseRoutes?: string[] },
): Promise<MeshPeerView> {
  const row = await ensureConfig(ctx);
  if (driverLower(row.driver) === 'none' || !row.enabled) {
    throw notFound('mesh (enable a driver first)', ctx.activeOrgId);
  }
  await requireOnlineNode(ctx, input.nodeId);

  const config = toOrgConfig(ctx, row);
  const control = makeControlPlane(config);
  const { enrollment, rendered } = await provisionNodePkg(
    config,
    { nodeId: input.nodeId, advertiseRoutes: input.advertiseRoutes },
    control,
  );

  const peer = await ctx.db.meshPeer.upsert({
    where: { nodeId: input.nodeId },
    create: {
      orgId: ctx.activeOrgId,
      nodeId: input.nodeId,
      driver: row.driver,
      status: 'ENROLLING',
    },
    update: { status: 'ENROLLING', driver: row.driver },
  });

  // Dispatch the join; the setup key rides this single frame only.
  let result: ApplyMeshResult | null = null;
  try {
    result = await ctx.hub.dispatch<ApplyMeshResult>(input.nodeId, 'applyMesh', { rendered });
    await ctx.db.meshPeer.update({
      where: { id: peer.id },
      data: {
        status: result.joined ? 'CONNECTED' : 'ENROLLED',
        meshIp: result.meshIp ?? peer.meshIp,
        peerId: result.peerId ?? peer.peerId,
        lastSeen: new Date(),
      },
    });
  } catch (e) {
    await ctx.db.meshPeer.update({
      where: { id: peer.id },
      data: { status: 'FAILED' },
    });
    await writeAudit(ctx, {
      action: 'mesh.peer.enrollFailed',
      targetType: 'meshPeer',
      targetId: peer.id,
      metadata: { nodeId: input.nodeId, error: e instanceof Error ? e.message : String(e) },
    });
    throw e;
  }

  await writeAudit(ctx, {
    action: 'mesh.peer.join',
    targetType: 'meshPeer',
    targetId: peer.id,
    metadata: { nodeId: input.nodeId, driver: enrollment.driver },
  });

  const fresh = await ctx.db.meshPeer.findUniqueOrThrow({ where: { id: peer.id } });
  return {
    id: fresh.id,
    nodeId: fresh.nodeId,
    meshIp: fresh.meshIp,
    status: fresh.status,
    lastSeen: fresh.lastSeen ? fresh.lastSeen.toISOString() : null,
  };
}
