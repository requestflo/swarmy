/**
 * Mesh service (epic: zero-trust-networking, MVP). Org-scoped orchestration:
 * pick the driver from `@swarmy/mesh`, provision a node (mint a single-use setup
 * key via the control plane), dispatch `applyMesh` over the existing `AgentHub`,
 * and derive peer status live (`./mesh-peers`: agent meshState + control plane). Mirrors `ingress.service.ts`.
 *
 * Secrets: the NetBird control-plane service token is encrypted at rest in
 * `MeshConfig.controlPlane` (vault) and never returned to the client; the setup
 * key it mints is single-use and injected JIT into the dispatched `applyMesh`
 * frame only — never persisted in plaintext.
 */
import {
  provisionNode as provisionNodePkg,
  NetbirdControlPlane,
  reconcileFromControlPlane,
  type DriverControlPlane,
  type MeshConfig as OrgMeshConfig,
  type MeshPeerInfo,
} from '@swarmy/mesh';
import type { ApplyMeshResult } from '@swarmy/core/protocol';
import { decryptSecret, encryptSecret, randomToken } from '@swarmy/core/crypto';
import { TRPCError } from '@trpc/server';
import type { OrgContext } from '../context';
import { writeAudit } from '../services/audit.service';
import { notFound } from '../errors';
import { requireOnlineNode } from './dispatch.service';
import { meshPeers, type LiveMeshPeer } from './mesh-peers';
import { meshConfigRepo } from './mesh-config.repo';

function badRequest(message: string): TRPCError {
  return new TRPCError({ code: 'BAD_REQUEST', message });
}

/** Controller driver ids ⇄ Prisma `MeshDriver` enum. */
export type MeshDriverId = 'netbird' | 'headscale' | 'none';
import type { MeshDriverEnum } from './mesh-config.repo';
const DRIVER_TO_ENUM: Record<MeshDriverId, MeshDriverEnum> = {
  netbird: 'NETBIRD',
  headscale: 'HEADSCALE',
  none: 'NONE',
};
const ENUM_TO_DRIVER: Record<string, MeshDriverId> = {
  NETBIRD: 'netbird',
  HEADSCALE: 'headscale',
  NONE: 'none',
};

function driverLower(d: string): MeshDriverId {
  return ENUM_TO_DRIVER[d.toUpperCase()] ?? 'none';
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

/** The org's mesh config (swarm-kv; defaults to driver NONE, disabled — a read never writes). */
async function ensureConfig(ctx: OrgContext): Promise<ConfigRow> {
  return meshConfigRepo.get(ctx, ctx.activeOrgId);
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
 * Build the provider control-plane binding for an org config. When the driver is
 * NetBird (or Headscale, which we drive over the same Admin-API shape) AND a URL
 * + decrypted service token are present, we return the REAL HTTP client
 * ({@link NetbirdControlPlane}: `POST /api/setup-keys`, `/api/peers`,
 * `/api/groups`, `/api/policies`). Otherwise we fall back to a local stub that
 * mints an opaque one-time key — so a fresh/unconfigured org still works and
 * tests don't need a live control plane. Tailscale/wireguard don't drive a
 * self-hosted Admin API; the stub's `createSetupKey` returns the configured
 * reusable key (or an opaque placeholder) for them.
 *
 * UNVERIFIED: the real NetBird client is credential-gated and coded to the
 * documented API but not exercised against a live control plane in this repo.
 */
function makeControlPlane(config: OrgMeshConfig): DriverControlPlane {
  const url = config.managementUrl ?? config.controlPlane.url;
  const token = config.controlPlane.serviceToken;
  if ((config.driver === 'netbird' || config.driver === 'headscale') && url && token) {
    return new NetbirdControlPlane({ managementUrl: url, serviceToken: token });
  }
  // Fallback / SaaS / no-control-plane drivers: opaque single-use key.
  return {
    async createSetupKey({ nodeId }) {
      void nodeId;
      return { setupKey: token ?? randomToken('msh') };
    },
    async listPeers(): Promise<MeshPeerInfo[]> {
      return [];
    },
    async revokePeer(): Promise<void> {},
  };
}

export interface MintedSetupKey {
  setupKey: string;
  managementUrl?: string;
  driver: MeshDriverId;
}

/**
 * Mint a single-use NetBird setup key for a not-yet-enrolled node, to embed in
 * a join token (epic: zero-trust-networking, mesh-first join). Returns `null`
 * when the org hasn't enabled mesh — the opt-in gate — so tokens minted for a
 * mesh-off org carry no mesh material and install exactly as before this
 * feature. Not persisted anywhere; the caller (token.service.ts) is the only
 * consumer, and it flows through the tRPC response once, same one-shot-reveal
 * discipline as the raw join token itself.
 */
export async function mintSetupKeyForOrg(ctx: OrgContext): Promise<MintedSetupKey | null> {
  const row = await ensureConfig(ctx);
  if (!row.enabled || driverLower(row.driver) === 'none') return null;

  const config = toOrgConfig(ctx, row);
  const control = makeControlPlane(config);
  const minted = await control.createSetupKey({ nodeId: `join-${randomToken('n')}` });
  return { setupKey: minted.setupKey, managementUrl: config.managementUrl, driver: driverLower(row.driver) };
}

export async function getConfig(ctx: OrgContext): Promise<MeshConfigView> {
  const row = await ensureConfig(ctx);
  const cp = readControlPlane(row);
  const peerCount = meshPeers.forOrg(ctx.activeOrgId).length;
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

export async function setDriver(ctx: OrgContext, driver: MeshDriverId): Promise<MeshConfigView> {
  await meshConfigRepo.update(ctx, ctx.activeOrgId, { driver: DRIVER_TO_ENUM[driver] });
  await writeAudit(ctx, {
    action: 'mesh.setDriver',
    targetType: 'meshConfig',
    targetId: ctx.activeOrgId,
    metadata: { driver },
  });
  return getConfig(ctx);
}

export async function setEnabled(ctx: OrgContext, enabled: boolean): Promise<MeshConfigView> {
  const row = await ensureConfig(ctx);
  // NetBird is the default once mesh is enabled (see @swarmy/mesh registry):
  // enabling with no driver chosen means "give me the recommended mesh", not
  // "enable nothing". An explicitly-chosen driver is never overridden.
  const defaultedDriver = enabled && row.driver === 'NONE' ? DRIVER_TO_ENUM.netbird : undefined;
  await meshConfigRepo.update(ctx, ctx.activeOrgId, { enabled, ...(defaultedDriver ? { driver: defaultedDriver } : {}) });
  await writeAudit(ctx, {
    action: 'mesh.setEnabled',
    targetType: 'meshConfig',
    targetId: ctx.activeOrgId,
    metadata: { enabled, ...(defaultedDriver ? { driverDefaulted: 'netbird' } : {}) },
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
  await meshConfigRepo.update(ctx, ctx.activeOrgId, {
    controlPlane: (next ?? {}) as Record<string, unknown>,
    managementUrl: input?.managementUrl ?? (input ? row.managementUrl : null),
  });
  await writeAudit(ctx, {
    action: input ? 'mesh.setControlPlane' : 'mesh.clearControlPlane',
    targetType: 'meshConfig',
    targetId: ctx.activeOrgId,
    metadata: { mode: input?.mode ?? null, managementUrl: input?.managementUrl ?? null },
  });
  return getConfig(ctx);
}

function toPeerView(p: LiveMeshPeer): MeshPeerView {
  return {
    id: p.nodeId,
    nodeId: p.nodeId,
    meshIp: p.meshIp,
    status: p.status,
    lastSeen: p.lastSeen ? p.lastSeen.toISOString() : null,
  };
}

/** An agent report older than this defers to the control plane's view. */
const AGENT_REPORT_STALE_MS = 90_000;

/**
 * The org's mesh peers, derived: the agents' live `meshState` reports, cross-
 * checked against the control plane's `listPeers` when one is configured
 * (NetBird names peers by hostname). The control plane fills in nodes whose
 * agent is silent or hasn't reported since a controller restart, and refreshes
 * stale agent reports. Nothing is stored.
 */
export async function listPeers(ctx: OrgContext): Promise<MeshPeerView[]> {
  const row = await ensureConfig(ctx);
  const driver = driverLower(row.driver);
  if (row.enabled && driver !== 'none') {
    const cpPeers = await makeControlPlane(toOrgConfig(ctx, row))
      .listPeers()
      .catch(() => [] as MeshPeerInfo[]);
    if (cpPeers.length > 0) {
      const nodes = (await ctx.db.node.findMany({
        where: { orgId: ctx.activeOrgId },
        select: { id: true, hostname: true },
      })) as { id: string; hostname: string }[];
      const byHost = new Map(nodes.map((n) => [n.hostname, n.id]));
      const now = Date.now();
      for (const cp of cpPeers) {
        const nodeId = cp.nodeId ? byHost.get(cp.nodeId) : undefined;
        if (!nodeId) continue;
        const live = meshPeers.get(nodeId);
        const stale = !live?.lastSeen || now - live.lastSeen.getTime() > AGENT_REPORT_STALE_MS;
        if (live && !stale) continue;
        const update = reconcileFromControlPlane(cp);
        meshPeers.upsert(ctx.activeOrgId, nodeId, { driver, ...update });
      }
    }
  }
  return meshPeers.forOrg(ctx.activeOrgId).map(toPeerView);
}

/**
 * Enroll a node: provision (mint setup key) → note the live peer → dispatch
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

  const driver = driverLower(row.driver);
  meshPeers.upsert(ctx.activeOrgId, input.nodeId, { driver, status: 'ENROLLING' });

  // Dispatch the join; the setup key rides this single frame only.
  let result: ApplyMeshResult | null = null;
  try {
    result = await ctx.hub.dispatch<ApplyMeshResult>(input.nodeId, 'applyMesh', { rendered });
    const prev = meshPeers.get(input.nodeId);
    meshPeers.upsert(ctx.activeOrgId, input.nodeId, {
      status: result.joined ? 'CONNECTED' : 'ENROLLED',
      meshIp: result.meshIp ?? prev?.meshIp ?? null,
      peerId: result.peerId ?? prev?.peerId ?? null,
      lastSeen: new Date(),
    });
  } catch (e) {
    meshPeers.upsert(ctx.activeOrgId, input.nodeId, { status: 'FAILED' });
    await writeAudit(ctx, {
      action: 'mesh.peer.enrollFailed',
      targetType: 'meshPeer',
      targetId: input.nodeId,
      metadata: { nodeId: input.nodeId, error: e instanceof Error ? e.message : String(e) },
    });
    throw e;
  }

  await writeAudit(ctx, {
    action: 'mesh.peer.join',
    targetType: 'meshPeer',
    targetId: input.nodeId,
    metadata: { nodeId: input.nodeId, driver: enrollment.driver },
  });

  return toPeerView(meshPeers.get(input.nodeId)!);
}

// ── Live peer reconciliation ─────────────────────────────────────────────────
// Agent `meshState` reports fold into the live map in `./mesh-peers`
// (`reconcileMeshPeer`); there is no peer table.
export { reconcileMeshPeer } from './mesh-peers';

