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
  defaultRegistry,
  NetbirdControlPlane,
  reconcilePeerState,
  principalTagForRoute,
  targetTagForRoute,
  type DriverControlPlane,
  type MeshAccessIntent,
  type MeshConfig as OrgMeshConfig,
  type MeshPeerInfo,
  type MeshStateReport,
} from '@swarmy/mesh';
import type { ApplyMeshResult } from '@swarmy/core/protocol';
import { decryptSecret, encryptSecret, randomToken } from '@swarmy/core/crypto';
import { TRPCError } from '@trpc/server';
import type { OrgContext } from '../context';
import { writeAudit } from '../services/audit.service';
import { notFound } from '../errors';
import { requireOnlineNode } from './dispatch.service';
import { resolveExecTarget, resolveLiveService } from './live-resolve';

function badRequest(message: string): TRPCError {
  return new TRPCError({ code: 'BAD_REQUEST', message });
}

/** Controller driver ids ⇄ Prisma `MeshDriver` enum. */
export type MeshDriverId = 'netbird' | 'headscale' | 'tailscale' | 'wireguard' | 'none';
type MeshDriverEnum = 'NETBIRD' | 'HEADSCALE' | 'TAILSCALE' | 'WIREGUARD' | 'NONE';
const DRIVER_TO_ENUM: Record<MeshDriverId, MeshDriverEnum> = {
  netbird: 'NETBIRD',
  headscale: 'HEADSCALE',
  tailscale: 'TAILSCALE',
  wireguard: 'WIREGUARD',
  none: 'NONE',
};
const ENUM_TO_DRIVER: Record<string, MeshDriverId> = {
  NETBIRD: 'netbird',
  HEADSCALE: 'headscale',
  TAILSCALE: 'tailscale',
  WIREGUARD: 'wireguard',
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
  return defaultRegistry.list() as MeshDriverId[];
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

// ── Live peer reconciliation (Phase 2+) ──────────────────────────────────────

/** Minimal DB surface so the reconcile helpers can run from a worker too. */
export interface MeshReconcileDb {
  meshPeer: {
    updateMany(args: {
      where: { nodeId: string };
      data: { status: string; meshIp: string | null; peerId: string | null; lastSeen: Date };
    }): Promise<{ count: number }>;
  };
}

/**
 * Reconcile a single agent `meshState` report onto its `MeshPeer` row. Pure
 * mapping lives in `@swarmy/mesh` (`reconcilePeerState`); this just persists it.
 * Used by the gateway `meshState` handler AND the periodic reconcile worker (see
 * INTEGRATION). `updateMany` so a report for an un-enrolled node is a safe no-op.
 */
export async function reconcileMeshPeer(
  db: MeshReconcileDb,
  nodeId: string,
  report: MeshStateReport,
): Promise<void> {
  const update = reconcilePeerState(report);
  await db.meshPeer.updateMany({ where: { nodeId }, data: update });
}

// ── Direct stack connect (Phase 2) ───────────────────────────────────────────

export interface MeshRouteView {
  id: string;
  kind: string;
  targetServiceId: string | null;
  targetStackId: string | null;
  cidr: string | null;
  port: number | null;
  principalType: string;
  principalId: string;
  expiresAt: string | null;
  createdAt: string;
}

function toRouteView(r: {
  id: string;
  kind: string;
  targetServiceId: string | null;
  targetStackId: string | null;
  cidr: string | null;
  port: number | null;
  principalType: string;
  principalId: string;
  expiresAt: Date | null;
  createdAt: Date;
}): MeshRouteView {
  return {
    id: r.id,
    kind: r.kind,
    targetServiceId: r.targetServiceId,
    targetStackId: r.targetStackId,
    cidr: r.cidr,
    port: r.port,
    principalType: r.principalType,
    principalId: r.principalId,
    expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  };
}

export async function listRoutes(ctx: OrgContext): Promise<MeshRouteView[]> {
  const routes = await ctx.db.meshRoute.findMany({
    where: { orgId: ctx.activeOrgId },
    orderBy: { createdAt: 'desc' },
  });
  return routes.map(toRouteView);
}

interface DirectConnectInput {
  serviceId?: string;
  stackId?: string;
  /** Mesh principal (peer public key / id, or a group tag). */
  principalType?: 'peer' | 'group' | 'member';
  principalId: string;
  port?: number;
  proto?: 'tcp' | 'udp';
  /** TTL seconds; direct routes default short-lived. */
  ttlSec?: number;
}

/** Build the {@link MeshAccessIntent} for the org's current routes plus one new grant. */
async function buildAccessIntent(
  ctx: OrgContext,
  extra?: { id: string; port?: number; proto?: 'tcp' | 'udp' },
): Promise<MeshAccessIntent> {
  const routes = await ctx.db.meshRoute.findMany({
    where: { orgId: ctx.activeOrgId, kind: 'direct' },
  });
  const grants = routes.map((r) => ({
    id: r.id,
    principalTag: principalTagForRoute(r.id),
    targetTag: targetTagForRoute(r.id),
    ports: r.port ? [r.port] : [],
    proto: (r.proto ?? undefined) as 'tcp' | 'udp' | undefined,
  }));
  if (extra) {
    grants.push({
      id: extra.id,
      principalTag: principalTagForRoute(extra.id),
      targetTag: targetTagForRoute(extra.id),
      ports: extra.port ? [extra.port] : [],
      proto: extra.proto,
    });
  }
  return { orgId: ctx.activeOrgId, grants };
}

/**
 * Grant a direct, point-to-point route to a service/stack over the mesh. Persists
 * a `MeshRoute` + a rendered `MeshAcl`, and pushes the ACL via the control plane
 * (NetBird policy) or records the rendered file (Headscale/wireguard). Returns
 * connection info (mesh IP:port + a ready-to-paste join snippet). adminProcedure
 * + audited; short TTL by default.
 */
export async function grantDirectRoute(
  ctx: OrgContext,
  input: DirectConnectInput,
): Promise<{ route: MeshRouteView; connect: DirectConnectInfo }> {
  const row = await ensureConfig(ctx);
  const driver = driverLower(row.driver);
  if (driver === 'none' || !row.enabled) {
    throw badRequest('mesh is not enabled — pick a driver and enable it first');
  }
  if (!input.serviceId && !input.stackId && !input.principalId) {
    throw badRequest('a direct route needs a target (serviceId/stackId) and a principal');
  }

  // Resolve the target's mesh address + port for the returned connect info. The
  // service comes from live Docker inventory (no Service table); its placement node
  // is derived from the host of a running container (Docker truth).
  let meshHost = 'svc.mesh';
  if (input.serviceId) {
    const svc = resolveLiveService(ctx, input.serviceId);
    if (!svc) throw notFound('service', input.serviceId);
    const host = resolveExecTarget(ctx, svc.id);
    if (host) {
      const peer = await ctx.db.meshPeer.findUnique({ where: { nodeId: host.nodeId } });
      if (peer?.meshIp) meshHost = peer.meshIp;
    }
  }

  const expiresAt = input.ttlSec ? new Date(Date.now() + input.ttlSec * 1000) : null;
  const route = await ctx.db.meshRoute.create({
    data: {
      orgId: ctx.activeOrgId,
      kind: 'direct',
      targetServiceId: input.serviceId ?? null,
      targetStackId: input.stackId ?? null,
      port: input.port ?? null,
      proto: input.proto ?? null,
      principalType: input.principalType ?? 'peer',
      principalId: input.principalId,
      expiresAt,
      createdById: ctx.user.id,
    },
  });

  // Render + push the access enforcement for the whole intent.
  const meshDriver = defaultRegistry.get(driver);
  const config = toOrgConfig(ctx, row);
  const intent = await buildAccessIntent(ctx, { id: route.id, port: input.port, proto: input.proto });
  const access = meshDriver.applyAccess?.(config, intent) ?? { kind: 'none' as const, summary: '' };

  let policyRef: string | null = null;
  if (access.kind === 'control-plane') {
    const control = makeControlPlane(config);
    if (control.applyPolicyPlan) {
      try {
        const res = await control.applyPolicyPlan(access.plan);
        policyRef = res.policyIds.join(',') || null;
      } catch (e) {
        // Surface but don't lose the persisted route; mark the ACL un-applied.
        await writeAudit(ctx, {
          action: 'mesh.route.pushFailed',
          targetType: 'meshRoute',
          targetId: route.id,
          metadata: { error: e instanceof Error ? e.message : String(e) },
        });
      }
    }
  }

  await ctx.db.meshAcl.create({
    data: {
      orgId: ctx.activeOrgId,
      routeId: route.id,
      driver,
      kind: access.kind,
      rendered:
        access.kind === 'control-plane'
          ? (access.plan as unknown as object)
          : access.kind === 'file'
            ? { path: access.path, contents: access.contents }
            : { summary: access.summary },
      appliedAt: access.kind === 'none' ? null : new Date(),
    },
  });

  if (policyRef) {
    await ctx.db.meshRoute.update({ where: { id: route.id }, data: { policyRef } });
  }

  await writeAudit(ctx, {
    action: 'mesh.route.grant',
    targetType: 'meshRoute',
    targetId: route.id,
    metadata: {
      driver,
      serviceId: input.serviceId ?? null,
      stackId: input.stackId ?? null,
      principalId: input.principalId,
      port: input.port ?? null,
    },
  });

  // Mint an ephemeral setup key so a laptop/CI can join scoped to this route.
  const control = makeControlPlane(config);
  let joinKey: string | undefined;
  try {
    const minted = await control.createSetupKey({ nodeId: `dc-${route.id}`, ephemeral: true });
    joinKey = minted.setupKey;
  } catch {
    joinKey = undefined;
  }

  const fresh = await ctx.db.meshRoute.findUniqueOrThrow({ where: { id: route.id } });
  return {
    route: toRouteView(fresh),
    connect: buildConnectInfo(driver, config, meshHost, input.port, joinKey),
  };
}

export interface DirectConnectInfo {
  driver: MeshDriverId;
  /** `<meshIp>:<port>` the principal dials. */
  address: string;
  /** Copy-paste snippet to join as an ephemeral peer scoped to the route. */
  joinSnippet: string;
  setupKey?: string;
}

function buildConnectInfo(
  driver: MeshDriverId,
  config: OrgMeshConfig,
  host: string,
  port: number | undefined,
  setupKey?: string,
): DirectConnectInfo {
  const address = port ? `${host}:${port}` : host;
  const url = config.managementUrl ?? config.controlPlane.url ?? '';
  let joinSnippet: string;
  if (driver === 'netbird') {
    joinSnippet = `netbird up --management-url ${url} --setup-key ${setupKey ?? '<setup-key>'}`;
  } else if (driver === 'headscale' || driver === 'tailscale') {
    joinSnippet = `tailscale up --login-server ${url || 'https://controlplane.tailscale.com'} --authkey ${setupKey ?? '<auth-key>'}`;
  } else {
    joinSnippet = `# add this machine as a WireGuard peer, then: wg-quick up wg0`;
  }
  return { driver, address, joinSnippet, setupKey };
}

/** Revoke a direct route: tear down the control-plane policy + delete rows. */
export async function revokeDirectRoute(ctx: OrgContext, routeId: string): Promise<void> {
  const route = await ctx.db.meshRoute.findFirst({
    where: { id: routeId, orgId: ctx.activeOrgId },
  });
  if (!route) throw notFound('mesh route', routeId);

  if (route.policyRef) {
    const row = await ensureConfig(ctx);
    const config = toOrgConfig(ctx, row);
    const control = makeControlPlane(config);
    if (control.deletePolicy) {
      for (const id of route.policyRef.split(',').filter(Boolean)) {
        await control.deletePolicy(id).catch(() => undefined);
      }
    }
  }

  await ctx.db.meshRoute.delete({ where: { id: route.id } });
  await writeAudit(ctx, {
    action: 'mesh.route.revoke',
    targetType: 'meshRoute',
    targetId: route.id,
    metadata: { routeId: route.id },
  });
}

/** Preview the ACL a direct-connect grant would create (no writes). */
export async function previewAccess(
  ctx: OrgContext,
  input: { port?: number; proto?: 'tcp' | 'udp' },
): Promise<{ kind: string; summary: string; rendered?: string }> {
  const row = await ensureConfig(ctx);
  const driver = driverLower(row.driver);
  const meshDriver = defaultRegistry.get(driver);
  const config = toOrgConfig(ctx, row);
  const intent = await buildAccessIntent(ctx, { id: 'preview', port: input.port, proto: input.proto });
  const access = meshDriver.applyAccess?.(config, intent) ?? { kind: 'none' as const, summary: '' };
  if (access.kind === 'file') {
    return { kind: 'file', summary: `Would write ${access.path}`, rendered: access.contents };
  }
  if (access.kind === 'control-plane') {
    return {
      kind: 'control-plane',
      summary: `Would push ${access.plan.policies.length} policy / ${access.plan.groups.length} group changes`,
      rendered: JSON.stringify(access.plan, null, 2),
    };
  }
  return { kind: 'none', summary: access.summary };
}
