/**
 * The self-hosted mesh control plane (plans/epic-self-hosted-mesh-and-fleets.md
 * M1): NetBird running inside swarmy as `swarmy-mesh-control` on one node,
 * supervised by that node's agent, with swarmy as its identity provider.
 *
 * State (MeshConfig.controlPlane, swarm-kv, vault-sealed):
 *   { mode: 'managed-by-swarmy', url, serviceTokenEnc, managed: ManagedControlPlane }
 * Every secret inside `managed` is an `encryptSecret` blob. Live status is the
 * hosting node's `meshState.control` telemetry (mesh-peers.ts), never stored.
 *
 * The reconcile (workers/mesh-people-reconcile.ts, 30 s) converges, in order:
 *   1. the bootstrap policy set (Default policy gone, nodes ↔ nodes, 12 h login expiry)
 *   2. swarmy as the ONE connector (confidential OIDC client `swarmy-mesh`)
 *   3. `localAuthDisabled` once the connector exists (break-glass flips it back)
 *   4. Litestream to Garage bucket `swarmy-mesh` once object storage is on
 *   5. the rendered config on the hosting node (applyMeshControl when it drifts)
 */
import { createHash } from 'node:crypto';
import {
  LITESTREAM_IMAGE_PINNED,
  MESH_CONTROL_DATA_DIR,
  MESH_CONTROL_ENV,
  NETBIRD_SERVER_IMAGE,
  NETBIRD_VERSION,
  NetbirdAdmin,
  bootstrapControlPlane,
  ensureSwarmyConnector,
  meshControlOidcCallback,
  meshControlPublicUrl,
  netbirdLitestreamDbs,
  renderLitestreamConfig,
  renderMeshControlConfig,
  type MeshControlTls,
  type NetbirdAdminApi,
} from '@swarmy/mesh';
import type { MeshControlSpec, MeshControlStatus } from '@swarmy/core/protocol';
import { decryptSecret, encryptSecret } from '@swarmy/core/crypto';
import { ensureOidcClient, oidcIssuer, rotateOidcClientSecret } from '@swarmy/auth';
import { TRPCError } from '@trpc/server';
import type { OrgContext } from '../context';
import { writeAudit } from './audit.service';
import { meshConfigRepo, type MeshConfigRow } from './mesh-config.repo';
import { meshControlLive, meshPeers } from './mesh-peers';
import { isMeshCidr } from './mesh-onmesh';
import { objectStoreState, provisionSystemBucketKey, retireSupersededSystemKeys } from './buckets.service';

/** The swarmy OIDC client NetBird's Dex uses as its connector (confidential). */
export const MESH_OIDC_CLIENT_ID = 'swarmy-mesh';
export const MESH_BACKUP_BUCKET = 'swarmy-mesh';
/** The mesh control plane's Litestream key (one per managed cluster; platform-owned, see platform-keys.ts). */
export function meshLitestreamKeyName(cluster: string): string {
  return `swarmy-mesh-litestream-${cluster}`;
}

export interface ManagedControlPlane {
  /** Cluster slug: namespaces every NetBird object (`swarmy:<c>:*`). */
  cluster: string;
  meshDomain: string;
  /** Where TLS ends for good (`edge` = swarmy's Caddy fronts NetBird). */
  tls: MeshControlTls;
  /**
   * The TLS handover (plan §2.3 step 8, QA-012). Behind the edge, NetBird
   * can't be served by a Caddy that doesn't exist yet (the edge deploys after
   * `swarm init`, which waits for the mesh). So it boots in `bootstrapTls`
   * (plain HTTP on :8081, exposed on that port) and the reconcile hands over
   * to `tls` once the edge answers for the mesh domain.
   */
  bootstrapTls?: MeshControlTls;
  /** When the handover to `tls` happened (ms); unset = still on bootstrapTls. */
  handedOverAt?: number;
  /** Controller node id of the node that runs `swarmy-mesh-control`. */
  controlNodeId?: string;
  /** Hostname of that node (the installer knows it before any node id exists). */
  controlNodeHostname?: string;
  image?: string;
  authSecretEnc: string;
  encryptionKeyEnc: string;
  /** The break-glass local owner (plan §2.4): email + vault-held password. */
  ownerEmail?: string;
  ownerPasswordEnc?: string;
  connector?: { id: string; clientSecretEnc: string };
  /** Break-glass: keep the local login on (CLI: `swarmy-agent mesh break-glass`). */
  breakGlass?: boolean;
  litestream?: { accessKeyId: string; secretEnc: string; bucket: string; prefix: string; endpoint: string; region: string };
  trustedProxies?: string[];
  /** PEM of a private CA NetBird must trust (swarmy's issuer behind it). */
  extraCaPem?: string;
  /**
   * NetBird's plain listener as the controller can reach it directly (behind
   * the edge: the control-plane node's docker0). Tried first; the public URL
   * is the fallback (the controller may run on another node).
   */
  adminUrl?: string;
  /** Last time the bootstrap policy set was asserted (ms). */
  bootstrappedAt?: number;
}

interface ControlPlaneDoc {
  mode?: 'managed-by-swarmy' | 'external';
  url?: string;
  serviceTokenEnc?: string;
  managed?: ManagedControlPlane;
}

function cpDoc(row: Pick<MeshConfigRow, 'controlPlane'>): ControlPlaneDoc {
  return (row.controlPlane as ControlPlaneDoc | null) ?? {};
}

export function managedOf(row: Pick<MeshConfigRow, 'controlPlane'>): ManagedControlPlane | null {
  const cp = cpDoc(row);
  return cp.mode === 'managed-by-swarmy' && cp.managed ? cp.managed : null;
}

async function patchManaged(ctx: OrgContext, patch: Partial<ManagedControlPlane>): Promise<ManagedControlPlane> {
  const row = await meshConfigRepo.update(ctx, ctx.activeOrgId, (cur) => {
    const cp = (cur.controlPlane as ControlPlaneDoc | null) ?? {};
    if (!cp.managed) return undefined;
    return { controlPlane: { ...cp, managed: { ...cp.managed, ...patch } } as Record<string, unknown> };
  });
  const m = managedOf(row);
  if (!m) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'the mesh control plane is not managed by swarmy' });
  return m;
}

function dec(blob: string | undefined): string | undefined {
  if (!blob) return undefined;
  try {
    return decryptSecret(blob);
  } catch {
    return undefined;
  }
}

/** The Admin API client for the org's managed control plane, or null. */
export function managedAdmin(row: MeshConfigRow): NetbirdAdminApi | null {
  const cp = cpDoc(row);
  const token = dec(cp.serviceTokenEnc);
  const url = row.managementUrl ?? cp.url;
  if (cp.mode !== 'managed-by-swarmy' || !token || !url) return null;
  const direct = cp.managed?.adminUrl?.replace(/\/+$/, '');
  if (!direct) return new NetbirdAdmin({ managementUrl: url, token });
  const pub = url.replace(/\/+$/, '');
  // Direct first; a connection error (the controller moved off that node)
  // retries the same request on the public URL.
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = String(input);
    try {
      return await fetch(u, { ...init, signal: AbortSignal.timeout(5000) });
    } catch {
      return fetch(u.replace(direct, pub), init);
    }
  }) as typeof fetch;
  return new NetbirdAdmin({ managementUrl: direct, token, fetchImpl });
}

/** The TLS mode NetBird runs with right now (bootstrap until the handover). */
export function effectiveTls(m: Pick<ManagedControlPlane, 'tls' | 'bootstrapTls' | 'handedOverAt'>): MeshControlTls {
  return m.bootstrapTls && !m.handedOverAt ? m.bootstrapTls : m.tls;
}

/** The URL peers use right now (for new routers, the card, connect info). */
export function currentPublicUrl(m: Pick<ManagedControlPlane, 'meshDomain' | 'tls' | 'bootstrapTls' | 'handedOverAt'>): string {
  return meshControlPublicUrl(m.meshDomain, effectiveTls(m));
}

/**
 * Is the edge serving the mesh domain? A real HTTPS request to the final
 * public URL (through the edge Caddy's `mesh-control` vhost, which proxies to
 * NetBird's plain listener in either mode). A private CA is trusted when set.
 */
export async function edgeServesMesh(m: ManagedControlPlane, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const url = `${meshControlPublicUrl(m.meshDomain, m.tls)}/api/instance`;
  try {
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(5000),
      ...(m.extraCaPem ? ({ tls: { ca: m.extraCaPem } } as RequestInit) : {}),
    });
    const body = await res.text();
    return res.ok && /setup_required/.test(body);
  } catch {
    return false;
  }
}

/** Render the spec the hosting agent runs. Pure over the managed doc. */
export function renderControlSpec(m: ManagedControlPlane): MeshControlSpec {
  const authSecret = dec(m.authSecretEnc);
  const encryptionKey = dec(m.encryptionKeyEnc);
  if (!authSecret || !encryptionKey) throw new Error('mesh control-plane secrets are missing from the vault');
  const configYaml = renderMeshControlConfig({
    meshDomain: m.meshDomain,
    tls: effectiveTls(m),
    authSecret,
    encryptionKey,
    // Connector first, then the flag (the server refuses to start otherwise).
    localAuthDisabled: Boolean(m.connector) && !m.breakGlass,
    trustedProxies: m.trustedProxies,
  });
  let litestream: MeshControlSpec['litestream'] = null;
  if (m.litestream) {
    const secret = dec(m.litestream.secretEnc);
    if (secret) {
      litestream = {
        image: LITESTREAM_IMAGE_PINNED,
        network: 'swarmy',
        env: { LITESTREAM_ACCESS_KEY_ID: m.litestream.accessKeyId, LITESTREAM_SECRET_ACCESS_KEY: secret },
        configYaml: renderLitestreamConfig({
          dbs: netbirdLitestreamDbs({
            dataDir: MESH_CONTROL_DATA_DIR,
            bucket: m.litestream.bucket,
            prefix: m.litestream.prefix,
            endpoint: m.litestream.endpoint,
            region: m.litestream.region,
          }),
          socketPath: '/run/swarmy-litestream/litestream.sock',
        }),
      };
    }
  }
  return {
    image: m.image ?? NETBIRD_SERVER_IMAGE,
    configYaml,
    env: { ...MESH_CONTROL_ENV },
    ...(m.extraCaPem ? { caPem: m.extraCaPem } : {}),
    litestream,
  };
}

export function configHash(spec: MeshControlSpec): string {
  return createHash('sha256').update(spec.configYaml).digest('hex');
}

/** The controller node id that hosts the control plane (by id, else by hostname). */
async function controlNode(ctx: OrgContext, m: ManagedControlPlane): Promise<string | null> {
  if (m.controlNodeId) return m.controlNodeId;
  const live = meshControlLive.get(ctx.activeOrgId);
  if (live) return live.nodeId;
  if (!m.controlNodeHostname) return null;
  const n = (await ctx.db.node.findFirst({
    where: { orgId: ctx.activeOrgId, hostname: m.controlNodeHostname },
    select: { id: true },
  })) as { id: string } | null;
  return n?.id ?? null;
}

// ── status (the Mesh settings control-plane card) ─────────────────────────────

export interface ControlPlaneCardView {
  managed: boolean;
  cluster: string | null;
  meshDomain: string | null;
  managementUrl: string | null;
  version: string;
  node: { id: string | null; hostname: string | null; online: boolean };
  status: MeshControlStatus | null;
  statusAt: string | null;
  identity: { connector: boolean; localLogin: boolean; breakGlass: boolean };
  backup: { configured: boolean; running: boolean; bucket: string | null };
  peers: { total: number; servers: number };
  tls: MeshControlTls['mode'] | null;
  /** One line per thing that needs attention, in plain words. */
  warnings: string[];
}

export async function getControlPlaneCard(ctx: OrgContext): Promise<ControlPlaneCardView> {
  const row = await meshConfigRepo.get(ctx, ctx.activeOrgId);
  const m = managedOf(row);
  const live = meshControlLive.get(ctx.activeOrgId);
  const servers = meshPeers.forOrg(ctx.activeOrgId).length;
  if (!m) {
    return {
      managed: false,
      cluster: null,
      meshDomain: null,
      managementUrl: row.managementUrl,
      version: NETBIRD_VERSION,
      node: { id: null, hostname: null, online: false },
      status: null,
      statusAt: null,
      identity: { connector: false, localLogin: true, breakGlass: false },
      backup: { configured: false, running: false, bucket: null },
      peers: { total: servers, servers },
      tls: null,
      warnings: [],
    };
  }
  const nodeId = await controlNode(ctx, m);
  const node = nodeId
    ? ((await ctx.db.node.findFirst({ where: { id: nodeId, orgId: ctx.activeOrgId }, select: { hostname: true } })) as { hostname: string } | null)
    : null;
  const status = live?.status ?? null;
  const warnings: string[] = [];
  if (!status) warnings.push('No report from the control-plane node yet.');
  else if (!status.running) warnings.push('The control plane is not running.');
  else if (status.waitingForConfig) warnings.push('The control plane restarted and is waiting for its config from the agent.');
  else if (!status.healthy) warnings.push('The control plane is running but not answering its health check.');
  if (!m.litestream) warnings.push('Not backed up yet: turn on object storage and swarmy starts Litestream to it.');
  if (m.meshDomain.endsWith('.sslip.io')) warnings.push(`${m.meshDomain} follows this node's IP, so moving the control plane means everyone signs in again. Use a domain you control to make moves seamless.`);
  if (m.bootstrapTls && !m.handedOverAt) {
    warnings.push(
      `Waiting for swarmy's edge to serve ${m.meshDomain} (TLS handover). Until then NetBird answers on ${currentPublicUrl(m)}; people access starts after the handover.`,
    );
  }
  if (m.breakGlass) warnings.push('Break-glass is on: the local NetBird owner can sign in. Turn it off when you are done.');
  let total = servers;
  const api = managedAdmin(row);
  if (api) total = (await api.listPeersFull().catch(() => [])).length || servers;
  return {
    managed: true,
    cluster: m.cluster,
    meshDomain: m.meshDomain,
    managementUrl: currentPublicUrl(m),
    version: (m.image ?? NETBIRD_SERVER_IMAGE).match(/:(\d+\.\d+\.\d+)/)?.[1] ?? NETBIRD_VERSION,
    node: { id: nodeId, hostname: node?.hostname ?? m.controlNodeHostname ?? null, online: nodeId ? ctx.hub.isOnline(nodeId) : false },
    status,
    statusAt: live?.at.toISOString() ?? null,
    identity: { connector: Boolean(m.connector), localLogin: !m.connector || Boolean(m.breakGlass), breakGlass: Boolean(m.breakGlass) },
    backup: { configured: Boolean(m.litestream), running: Boolean(status?.litestream?.running), bucket: m.litestream?.bucket ?? null },
    peers: { total, servers },
    tls: effectiveTls(m).mode,
    warnings,
  };
}

// ── reconcile ────────────────────────────────────────────────────────────────

export interface ControlReconcileResult {
  managed: boolean;
  steps: string[];
}

const BOOTSTRAP_EVERY_MS = 5 * 60_000;

/**
 * Converge the org's managed control plane. Idempotent; a step that can't run
 * yet (the hosting node offline, object storage off) is skipped this tick.
 */
export async function reconcileMeshControl(ctx: OrgContext, opts: { force?: boolean } = {}): Promise<ControlReconcileResult> {
  let row = await meshConfigRepo.get(ctx, ctx.activeOrgId);
  let m = managedOf(row);
  if (!m || !row.enabled) return { managed: false, steps: [] };
  const steps: string[] = [];
  const api = managedAdmin(row);

  // 1. Bootstrap policy set (cheap, but not every 30 s).
  if (api && (opts.force || !m.bootstrappedAt || Date.now() - m.bootstrappedAt > BOOTSTRAP_EVERY_MS)) {
    try {
      const r = await bootstrapControlPlane(api, { cluster: m.cluster });
      if (r.changes.length) {
        steps.push(`bootstrap: ${r.changes.map((c) => `${c.op} ${c.kind} ${c.name}`).join(', ')}`);
        await writeAudit(ctx, { action: 'mesh.control.bootstrap', targetType: 'meshConfig', targetId: ctx.activeOrgId, metadata: { changes: r.changes } });
      }
      m = await patchManaged(ctx, { bootstrappedAt: Date.now() });
    } catch (e) {
      steps.push(`bootstrap failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 1b. The TLS handover: once the edge serves the mesh domain, NetBird
  // restarts on its final TLS mode (step 5 applies it). Peers joined before it
  // keep working: their management URL (the :8081 listener) stays served, and
  // signal/relay move to the edge URL with the next network map.
  if (m.bootstrapTls && !m.handedOverAt) {
    if (await edgeServesMesh(m)) {
      m = await patchManaged(ctx, { handedOverAt: Date.now() });
      steps.push(`TLS handover: ${m.meshDomain} now served by the edge`);
      await writeAudit(ctx, {
        action: 'mesh.control.handover',
        targetType: 'meshConfig',
        targetId: ctx.activeOrgId,
        metadata: { from: m.bootstrapTls?.mode ?? null, to: m.tls.mode, url: meshControlPublicUrl(m.meshDomain, m.tls) },
      });
    } else {
      steps.push(`TLS handover pending: the edge doesn't serve ${m.meshDomain} yet`);
    }
  }
  const handedOver = !m.bootstrapTls || Boolean(m.handedOverAt);
  // Dex bakes `<issuer>/callback` into a connector when it is CREATED, so the
  // connector must wait until NetBird RUNS the final config (the restart in
  // step 5), not just until the handover was decided (seen in the e2e: a
  // connector made in the same tick kept the bootstrap http:// callback).
  const liveNow = meshControlLive.get(ctx.activeOrgId);
  const runsFinal = !m.bootstrapTls || (handedOver && liveNow?.status.configHash === configHash(renderControlSpec(m)) && Boolean(liveNow?.status.healthy));

  // 2. Swarmy as the connector (after the handover: the callback is the final URL).
  if (api && !m.connector && handedOver && runsFinal) {
    try {
      const callback = meshControlOidcCallback(m.meshDomain, m.tls);
      let client = await ensureOidcClient(ctx.db as never, {
        clientId: MESH_OIDC_CLIENT_ID,
        name: `NetBird (${m.cluster})`,
        type: 'confidential',
        skipConsent: true,
        redirectUris: [callback],
      });
      // A pre-existing client's secret is only a hash: mint a fresh one.
      if (!client.clientSecret) client = await rotateOidcClientSecret(ctx.db as never, MESH_OIDC_CLIENT_ID);
      const conn = await ensureSwarmyConnector(api, {
        name: 'swarmy',
        issuer: oidcIssuer(),
        clientId: MESH_OIDC_CLIENT_ID,
        clientSecret: client.clientSecret!,
      });
      m = await patchManaged(ctx, { connector: { id: conn.id, clientSecretEnc: encryptSecret(client.clientSecret!) } });
      steps.push(`connector ${conn.created ? 'registered' : 'adopted'} (${conn.id})`);
      await writeAudit(ctx, {
        action: 'mesh.control.connector',
        targetType: 'meshConfig',
        targetId: ctx.activeOrgId,
        metadata: { connectorId: conn.id, issuer: oidcIssuer(), redirect: callback },
      });
    } catch (e) {
      steps.push(`connector failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 4. Backups, once object storage exists.
  if (!m.litestream) {
    const os = await objectStoreState(ctx).catch(() => ({ enabled: false as const }));
    if (os.enabled) {
      try {
        const keyName = meshLitestreamKeyName(m.cluster);
        const cred = await provisionSystemBucketKey(ctx, { bucket: MESH_BACKUP_BUCKET, keyName });
        m = await patchManaged(ctx, {
          litestream: {
            accessKeyId: cred.accessKeyId,
            secretEnc: encryptSecret(cred.secretAccessKey),
            bucket: cred.bucket,
            prefix: `${m.cluster}/netbird`,
            endpoint: cred.endpoint,
            region: cred.region,
          },
        });
        // One key per cluster: a re-created control plane re-mints; the keys
        // the lost credential left behind go now (QA-081).
        await retireSupersededSystemKeys(ctx, keyName, cred.accessKeyId);
        steps.push('litestream key provisioned');
      } catch (e) {
        steps.push(`litestream key failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // 5. The config on the hosting node.
  const nodeId = await controlNode(ctx, m);
  if (nodeId && !m.controlNodeId) m = await patchManaged(ctx, { controlNodeId: nodeId });
  if (nodeId && ctx.hub.isOnline(nodeId)) {
    const spec = renderControlSpec(m);
    const live = meshControlLive.get(ctx.activeOrgId);
    const drift =
      opts.force ||
      !live ||
      live.status.configHash !== configHash(spec) ||
      (live.status.image && live.status.image !== spec.image) ||
      Boolean(spec.litestream) !== Boolean(live.status.litestream?.running);
    if (drift) {
      try {
        const st = await ctx.hub.dispatch<MeshControlStatus>(nodeId, 'mesh.control', { action: 'apply', spec }, { timeoutMs: 120_000 });
        meshControlLive.report(ctx.activeOrgId, nodeId, st);
        steps.push(`applied config (${st.healthy ? 'healthy' : st.running ? 'starting' : 'not running'})`);
      } catch (e) {
        steps.push(`apply failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  row = await meshConfigRepo.get(ctx, ctx.activeOrgId);
  return { managed: true, steps };
}

/** Break-glass on/off (admin, audited): re-shows the local NetBird login. */
export async function setBreakGlass(ctx: OrgContext, on: boolean): Promise<ControlPlaneCardView> {
  await patchManaged(ctx, { breakGlass: on });
  await writeAudit(ctx, { action: on ? 'mesh.control.breakGlass.on' : 'mesh.control.breakGlass.off', targetType: 'meshConfig', targetId: ctx.activeOrgId, metadata: {} });
  await reconcileMeshControl(ctx, { force: true });
  return getControlPlaneCard(ctx);
}

/**
 * Move the control plane to another manager (plan §2.5): fence the old one
 * (stop if its agent is alive), restore the Litestream replica into the
 * target's empty volume and start it there. Peers reconnect by themselves when
 * the mesh domain follows (swarmy-dns / an edge name); an sslip.io name pins the
 * old IP, so that move is refused with the reason.
 */
export async function moveControlPlane(ctx: OrgContext, targetNodeId: string): Promise<ControlPlaneCardView> {
  const row = await meshConfigRepo.get(ctx, ctx.activeOrgId);
  const m = managedOf(row);
  if (!m) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'the mesh control plane is not managed by swarmy' });
  if (!m.litestream) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'turn on object storage first: a move restores the control plane from its Litestream backup' });
  if (m.meshDomain.endsWith('.sslip.io')) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `${m.meshDomain} is tied to this node's IP. Put the mesh on a domain you control (mesh.<your zone>) before moving it.`,
    });
  }
  if (!ctx.hub.isOnline(targetNodeId)) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'the target node is offline' });
  const from = await controlNode(ctx, m);
  if (from === targetNodeId) return getControlPlaneCard(ctx);
  if (from && ctx.hub.isOnline(from)) {
    await ctx.hub.dispatch(from, 'mesh.control', { action: 'stop' }, { timeoutMs: 60_000 });
  }
  const spec = renderControlSpec(m);
  const st = await ctx.hub.dispatch<MeshControlStatus>(targetNodeId, 'mesh.control', { action: 'restore', spec }, { timeoutMs: 300_000 });
  meshControlLive.report(ctx.activeOrgId, targetNodeId, st);
  const target = (await ctx.db.node.findFirst({ where: { id: targetNodeId, orgId: ctx.activeOrgId }, select: { hostname: true } })) as { hostname: string } | null;
  await patchManaged(ctx, { controlNodeId: targetNodeId, controlNodeHostname: target?.hostname });
  await writeAudit(ctx, {
    action: 'mesh.control.move',
    targetType: 'meshConfig',
    targetId: ctx.activeOrgId,
    metadata: { from, to: targetNodeId, restored: st.restored ?? null },
  });
  return getControlPlaneCard(ctx);
}

// ── TLS handover: the edge Caddy fronts the mesh domain (plan §2.3 step 8) ────

/**
 * The controller vhost for the mesh domain when NetBird runs behind the edge
 * (`tls.mode === 'edge'`): gRPC h2c + REST/IdP/relay to NetBird's plain
 * listener. The cert then lives in the edge's CertMagic store like every other
 * swarmy name.
 *
 * Upstream (QA-071): the control-plane node's MESH address, not docker0. The
 * rendered config is the same for every edge, and a docker0 upstream only
 * works on the control node itself: every other edge answered 502 for the mesh
 * host. NetBird listens on all interfaces (`:8081`), wt0 carries it between
 * nodes, and on the control node itself the mesh IP is local even before wt0
 * is up (the mesh pin's `swarmy-mesh0`, QA-059). Until that node has reported
 * a mesh IP, the configured listener (docker0) stays: the pre-fix behaviour.
 */
export async function meshControlVhosts(ctx: OrgContext): Promise<
  { domain: string; upstream: string; targetPath: string; kind: 'mesh-control'; tls: 'auto' }[]
> {
  const row = await meshConfigRepo.get(ctx, ctx.activeOrgId).catch(() => null);
  const m = row ? managedOf(row) : null;
  if (!m || m.tls.mode !== 'edge' || !row?.enabled) return [];
  const meshIp = m.controlNodeId
    ? meshPeers.get(m.controlNodeId)?.meshIp ?? advertisedMeshIp(ctx.hub.nodeInfoFor?.(m.controlNodeId)?.addr)
    : undefined;
  return [
    { domain: m.meshDomain, upstream: meshControlUpstream(m.tls.listen, meshIp), targetPath: '/', kind: 'mesh-control', tls: 'auto' },
  ];
}

/** A swarm advertise address (`host[:port]`) that is a mesh IP, bare. Pure. */
function advertisedMeshIp(addr: string | null | undefined): string | undefined {
  const host = addr?.replace(/:\d+$/, '');
  return host && isMeshCidr(host) ? host : undefined;
}

/** `listen` (`172.17.0.1:8081`) re-pointed at the control node's mesh IP when known. Pure. */
export function meshControlUpstream(listen: string, meshIp: string | undefined): string {
  if (!meshIp || !isMeshCidr(meshIp)) return listen;
  const port = /:(\d+)$/.exec(listen)?.[1] ?? '8081';
  return `${meshIp}:${port}`;
}
