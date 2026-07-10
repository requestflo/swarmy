import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  CloseCode,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_METRICS_INTERVAL_MS,
  PROTOCOL_VERSION,
  parseAgentEnvelope,
  type RegisterPayload,
} from '@swarmy/core/protocol';
import { SESSION_TOKEN_PREFIX, parseNodeProfile, type NodeProfile } from '@swarmy/core';
import type { LogLine } from '@swarmy/core/views';
import { prisma } from '@swarmy/db';
import {
  enrollMeshNode,
  orchestrateSwarmMembership,
  stampProfileLabels,
  stampReportedPublicIp,
  systemContext,
} from '@swarmy/trpc';
import { authRegistry } from '@swarmy/auth';
import { decideJoinAuth } from './join-auth';
import type { AgentHubImpl } from './hub';
import type { GatewayStore } from './store';
import type { AgentSocket, ConnectionRegistry } from './registry';
import { terminalHub } from '../terminal';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

interface Deps {
  hub: AgentHubImpl;
  store: GatewayStore;
  registry: ConnectionRegistry;
}

export async function handleAgentMessage(ws: AgentSocket, raw: string, deps: Deps): Promise<void> {
  let env;
  try {
    env = parseAgentEnvelope(JSON.parse(raw));
  } catch {
    ws.close(CloseCode.MESSAGE_TOO_LARGE, 'malformed');
    return;
  }

  if (ws.data.state === 'await_register' && env.type !== 'register') {
    ws.close(CloseCode.UNAUTHORIZED, 'expected register');
    return;
  }

  switch (env.type) {
    case 'register':
      await handleRegister(ws, env.payload, deps);
      return;
    case 'heartbeat': {
      const nodeId = ws.data.nodeId;
      // lastSeen is hub-truth now (Node.lastSeenAt column removed in the rip-out).
      if (nodeId) {
        deps.store.lastSeen.set(nodeId, Date.now());
        // Geo-edge: keep the public-ip label current (no-op when unchanged).
        const orgId = deps.store.nodeOrg.get(nodeId);
        if (orgId) {
          void stampReportedPublicIp(deps.hub, orgId, nodeId, env.payload.publicIp, ws.remoteAddress);
        }
      }
      return;
    }
    case 'metrics': {
      const nodeId = ws.data.nodeId;
      if (!nodeId) return;
      const cpuCount = deps.store.nodeCpuCount.get(nodeId) || 1;
      const p = env.payload;
      deps.store.setNodeStats(nodeId, {
        nodeId,
        ts: p.sampledAt,
        cpuPercent: p.node.cpuPercent / cpuCount,
        cpuCount,
        memUsedBytes: p.node.memUsedBytes,
        memTotalBytes: p.node.memTotalBytes,
        netRxBytes: p.node.netRxBytes ?? 0,
        netTxBytes: p.node.netTxBytes ?? 0,
        fsUsedBytes: p.node.fsUsedBytes ?? null,
        fsTotalBytes: p.node.fsTotalBytes ?? null,
      });
      deps.store.containerStats.set(
        nodeId,
        p.containers.map((c) => ({
          containerId: c.containerId,
          name: c.name,
          cpuPercent: c.cpuPercent,
          memUsedBytes: c.memUsedBytes,
          memLimitBytes: c.memLimitBytes,
          netRxBytes: c.netRxBytes,
          netTxBytes: c.netTxBytes,
        })),
      );
      return;
    }
    case 'containerList': {
      const nodeId = ws.data.nodeId;
      if (nodeId) deps.store.containers.set(nodeId, env.payload.containers);
      return;
    }
    case 'serviceState': {
      const nodeId = ws.data.nodeId;
      // Keep the FULL live Docker service info (labels/networks/env/ports) — it is
      // the source of truth for the inventory + canvas. Thin views derive from it.
      if (nodeId) {
        deps.store.serviceInfo.set(nodeId, env.payload.services);
        deps.store.managers.set(nodeId, env.payload.isManager);
        // Legacy agents omit swarmState — assume active (their behaviour is unchanged).
        deps.store.swarmStates.set(nodeId, env.payload.swarmState ?? 'active');
      }
      return;
    }
    case 'swarmLeft': {
      // Graceful departure: the agent's watchdog saw the node leave the swarm and
      // is exiting. Correct our view immediately (so the node stops showing as a
      // healthy manager the instant it happens), audit it, and emit an event so
      // future features (alerts, incidents, workload re-placement) can react.
      const nodeId = ws.data.nodeId;
      if (nodeId) {
        deps.store.swarmStates.set(nodeId, env.payload.swarmState);
        deps.store.managers.set(nodeId, false);
        deps.store.swarmNodes.set(nodeId, []);
        const orgId = deps.store.nodeOrg.get(nodeId);
        if (orgId) {
          deps.store.swarmLeftEvent.emit({
            nodeId,
            orgId,
            swarmState: env.payload.swarmState,
            at: env.payload.at,
          });
          void prisma.auditLog
            .create({
              data: {
                orgId,
                actorType: 'system',
                action: 'node.swarm.left',
                targetType: 'node',
                targetId: nodeId,
                metadata: { swarmState: env.payload.swarmState, reason: env.payload.reason ?? null },
              },
            })
            .catch(() => {
              /* audit is best-effort; never block the gateway on it */
            });
        }
      }
      return;
    }
    case 'nodeList': {
      // Live swarm node inventory from a manager — Docker-truth node role/status/labels.
      const nodeId = ws.data.nodeId;
      if (nodeId) deps.store.swarmNodes.set(nodeId, env.payload.nodes);
      return;
    }
    case 'commandResult': {
      const { commandId, status, result, error } = env.payload;
      // Intermediate progress frames ('running'/'accepted') are NOT terminal —
      // settling on them would resolve/reject the dispatch before the real
      // outcome arrives. Only settle on a terminal status.
      if (status === 'running' || status === 'accepted') return;
      const ok = status === 'succeeded';
      deps.hub.settleCommand(commandId, ok, result, error ? { message: error.message } : undefined);
      return;
    }
    case 'logChunk': {
      const { commandId, stream, data, seq } = env.payload;
      const line: LogLine = { seq, stream, ts: env.ts, message: data };
      deps.hub.emitLog(commandId, line);
      return;
    }
    case 'termStarted':
    case 'termData':
    case 'termExit':
      terminalHub.onAgentTermFrame(env.type, env.payload);
      return;
    case 'ingressNodeStatus': {
      const nodeId = ws.data.nodeId;
      if (nodeId) deps.store.ingressNodeStatus.set(nodeId, env.payload);
      return;
    }
    case 'meshState': {
      const nodeId = ws.data.nodeId;
      if (!nodeId) return;
      const p = env.payload;
      await prisma.meshPeer
        .updateMany({
          where: { nodeId },
          data: {
            status: p.connected ? 'ONLINE' : 'OFFLINE',
            meshIp: p.meshIp ?? null,
            peerId: p.peerId ?? null,
            lastSeen: new Date(),
          },
        })
        .catch(() => undefined);
      return;
    }
    default:
      return;
  }
}

async function handleRegister(ws: AgentSocket, payload: RegisterPayload, deps: Deps): Promise<void> {
  const { auth, facts } = payload;
  let nodeId: string | null = null;
  let orgId: string | null = null;
  let roleHint: 'manager' | 'worker' | null = null;
  let profile: NodeProfile | null = null;

  if (auth.kind === 'join') {
    const token = await prisma.joinToken.findUnique({ where: { tokenHash: sha256(auth.joinToken) } });
    // The re-adoption target: the existing node for this org+hostname (if any).
    // Its token binding is what makes a consumed token still valid for the ONE
    // box it enrolled — the durable fallback credential that lets reboots and
    // "re-run the one-liner" self-heal. Decision logic (incl. the revocation
    // kill switch) lives in decideJoinAuth so it's unit-tested in isolation.
    const owner = token
      ? await prisma.node.findUnique({
          where: { orgId_name: { orgId: token.orgId, name: facts.hostname } },
          select: { id: true, joinTokenId: true },
        })
      : null;
    const decision = decideJoinAuth(token, owner);

    if (decision.kind === 'reject') {
      ws.close(decision.code === 'forbidden' ? CloseCode.FORBIDDEN : CloseCode.UNAUTHORIZED, decision.reason);
      return;
    }
    // token is non-null past a non-reject decision.
    orgId = token!.orgId;

    if (decision.kind === 'readopt') {
      nodeId = decision.nodeId; // re-adoption, not an enrollment — uses stays put
    } else {
      // The Node row is now an enrollment/identity record only — role/status/labels/
      // resources/version are Docker-truth and live in the hub (serviceState/nodeList).
      const node = await prisma.node.upsert({
        where: { orgId_name: { orgId, name: facts.hostname } },
        create: { orgId, name: facts.hostname, hostname: facts.hostname, joinTokenId: token!.id },
        update: { joinTokenId: token!.id },
      });
      nodeId = node.id;
      await prisma.joinToken.update({ where: { id: token!.id }, data: { uses: { increment: 1 } } });
    }
    roleHint = token!.roleHint === 'MANAGER' ? 'manager' : token!.roleHint === 'WORKER' ? 'worker' : null;
    profile = parseNodeProfile(token!.profile);
  } else {
    const node = await prisma.node.findUnique({ where: { id: auth.nodeId } });
    if (!node || !node.sessionSecretHash || !safeEqualHex(node.sessionSecretHash, sha256(auth.sessionSecret))) {
      ws.close(CloseCode.FORBIDDEN, 'invalid session');
      return;
    }
    nodeId = node.id;
    orgId = node.orgId;
  }

  // Both auth branches either assigned these or returned; assert for the type
  // narrower and as a defensive backstop.
  if (!nodeId || !orgId) {
    ws.close(CloseCode.UNAUTHORIZED, 'registration failed');
    return;
  }

  // Rotate the per-node session secret on every successful register.
  const sessionSecret = `${SESSION_TOKEN_PREFIX}_${randomBytes(32).toString('base64url')}`;
  const updated = await prisma.node.update({
    where: { id: nodeId },
    data: { sessionSecretHash: sha256(sessionSecret), sessionVersion: { increment: 1 } },
    select: { sessionVersion: true },
  });

  deps.store.nodeOrg.set(nodeId, orgId);
  deps.store.nodeCpuCount.set(nodeId, facts.cpuCount);
  deps.store.nodeHostname.set(nodeId, facts.hostname);
  deps.store.agentBuild.set(nodeId, { version: facts.agentVersion, packaging: facts.agentPackaging });
  const previous = deps.registry.add(nodeId, ws);
  previous?.close(CloseCode.DUPLICATE_SESSION, 'newer session');
  ws.data.state = 'ready';
  ws.data.nodeId = nodeId;
  ws.data.orgId = orgId;

  ws.send(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      id: crypto.randomUUID(),
      ts: Date.now(),
      type: 'registerAck',
      payload: {
        nodeId,
        sessionCredential: { sessionSecret, sessionVersion: updated.sessionVersion },
        negotiatedVersion: PROTOCOL_VERSION,
        heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
        metricsIntervalMs: DEFAULT_METRICS_INTERVAL_MS,
        serverTime: Date.now(),
      },
    }),
  );

  // Geo-edge: stamp the self-detected public IP once the node's swarm identity
  // is known (label dispatch no-ops until then; heartbeats re-try it anyway).
  void stampReportedPublicIp(deps.hub, orgId, nodeId, facts.publicIp, ws.remoteAddress);

  // WS7 install profiles: first-register-with-token only. The label bundle
  // stamps once the swarm join lands (retried inside); private-mesh nodes are
  // auto-enrolled into the org mesh when a driver is enabled — quietly a no-op
  // otherwise (the profile is a starting point, never a hard requirement).
  if (profile) {
    void stampProfileLabels(deps.hub, orgId, nodeId, profile);
    // Mesh-first join (epic: zero-trust-networking): a node launched with an
    // embedded setup key already joined + confirmed mesh connectivity before
    // this register call (facts.meshConnected). Only fall back to the
    // profile-triggered dashboard-driven enrollment path for nodes that
    // didn't self-enroll — otherwise this would mint/dispatch a second,
    // redundant (and wasted, since NetBird setup keys are single-use) join.
    if (profile === 'private-mesh' && !facts.meshConnected) {
      const ctx = systemContext({ db: prisma as never, hub: deps.hub, auth: authRegistry as never }, orgId);
      void enrollMeshNode(ctx, { nodeId }).catch((err) => {
        console.warn(
          `[profiles] node ${nodeId}: private-mesh auto-enroll skipped:`,
          err instanceof Error ? err.message : err,
        );
      });
    }
  }

  // node-onboarding P2: init or join the org's Docker Swarm (best-effort, async).
  // Surface failures (e.g. a missing SWARMY_SECRET_KEY blocking the token vault)
  // instead of swallowing them — a silent failure here leaves the swarm running
  // but unrecorded (no swarm_config, node stuck WORKER).
  void orchestrateSwarmMembership({
    db: prisma as never,
    hub: deps.hub,
    orgId,
    nodeId,
    roleHint,
    alreadyInSwarm: facts.swarmRole !== 'none',
    // Mesh-first join: advertise the node's confirmed mesh IP instead of its
    // LAN address so swarm control + data-plane traffic rides the mesh.
    // Absent/unconnected ⇒ undefined ⇒ agent's existing LAN self-derivation.
    meshIp: facts.meshConnected ? (facts.meshIp ?? null) : null,
  }).catch((err) => {
    console.error('[swarm] membership orchestration failed:', err instanceof Error ? err.message : err);
  });
}

export function handleAgentClose(ws: AgentSocket, deps: Deps): void {
  const nodeId = ws.data.nodeId;
  if (!nodeId) return;
  deps.registry.remove(nodeId, ws);
  // Node liveness is hub-truth now (status/lastSeenAt columns removed). forget()
  // retains a last-known snapshot for ABAC/dr-reconcile, then drops live telemetry.
  deps.store.forget(nodeId);
}
