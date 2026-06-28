import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  CloseCode,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_METRICS_INTERVAL_MS,
  PROTOCOL_VERSION,
  parseAgentEnvelope,
  type RegisterPayload,
} from '@swarmy/core/protocol';
import { SESSION_TOKEN_PREFIX } from '@swarmy/core';
import type { LogLine } from '@swarmy/core/views';
import { prisma } from '@swarmy/db';
import { orchestrateSwarmMembership } from '@swarmy/trpc';
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
      if (nodeId) {
        await prisma.node
          .update({ where: { id: nodeId }, data: { lastSeenAt: new Date() } })
          .catch(() => undefined);
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
      if (nodeId) deps.store.serviceInfo.set(nodeId, env.payload.services);
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

  if (auth.kind === 'join') {
    const token = await prisma.joinToken.findUnique({ where: { tokenHash: sha256(auth.joinToken) } });
    if (!token || token.revokedAt || (token.expiresAt && token.expiresAt.getTime() < Date.now())) {
      ws.close(CloseCode.UNAUTHORIZED, 'invalid join token');
      return;
    }
    if (token.maxUses != null && token.uses >= token.maxUses) {
      ws.close(CloseCode.FORBIDDEN, 'token exhausted');
      return;
    }
    orgId = token.orgId;
    const node = await prisma.node.upsert({
      where: { orgId_name: { orgId, name: facts.hostname } },
      create: {
        orgId,
        name: facts.hostname,
        hostname: facts.hostname,
        role: facts.swarmRole === 'manager' ? 'MANAGER' : 'WORKER',
        status: 'ONLINE',
        dockerVersion: facts.dockerVersion,
        os: facts.os,
        arch: facts.arch,
        totalCpu: facts.cpuCount,
        totalMemoryBytes: BigInt(Math.round(facts.memTotalBytes)),
        agentVersion: facts.agentVersion,
        lastSeenAt: new Date(),
        joinTokenId: token.id,
      },
      update: {
        status: 'ONLINE',
        role: facts.swarmRole === 'manager' ? 'MANAGER' : 'WORKER',
        dockerVersion: facts.dockerVersion,
        agentVersion: facts.agentVersion,
        lastSeenAt: new Date(),
        joinTokenId: token.id,
      },
    });
    nodeId = node.id;
    roleHint = token.roleHint === 'MANAGER' ? 'manager' : token.roleHint === 'WORKER' ? 'worker' : null;
    await prisma.joinToken.update({ where: { id: token.id }, data: { uses: { increment: 1 } } });
  } else {
    const node = await prisma.node.findUnique({ where: { id: auth.nodeId } });
    if (!node || !node.sessionSecretHash || !safeEqualHex(node.sessionSecretHash, sha256(auth.sessionSecret))) {
      ws.close(CloseCode.FORBIDDEN, 'invalid session');
      return;
    }
    nodeId = node.id;
    orgId = node.orgId;
    await prisma.node.update({
      where: { id: node.id },
      data: { status: 'ONLINE', lastSeenAt: new Date(), agentVersion: facts.agentVersion },
    });
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
  }).catch((err) => {
    console.error('[swarm] membership orchestration failed:', err instanceof Error ? err.message : err);
  });
}

export async function handleAgentClose(ws: AgentSocket, deps: Deps): Promise<void> {
  const nodeId = ws.data.nodeId;
  if (!nodeId) return;
  deps.registry.remove(nodeId, ws);
  deps.store.forget(nodeId);
  await prisma.node
    .update({ where: { id: nodeId }, data: { status: 'OFFLINE', lastSeenAt: new Date() } })
    .catch(() => undefined);
}
