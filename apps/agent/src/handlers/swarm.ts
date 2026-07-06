/**
 * Swarm init/join handler (node-onboarding epic, PHASE-2+).
 *
 * Runs `docker swarm init` / `docker swarm join` on the LOCAL Docker socket in
 * response to a controller `swarmJoin` command. The agent is the only party that
 * ever touches the box's socket; the controller merely tells it which mode to run
 * and (for join) hands over a short-lived Docker join token.
 *
 * On `init` the agent returns the freshly-minted worker+manager join tokens so
 * the controller can store them (encrypted) and hand a worker token to the next
 * node that registers. Idempotent: re-running against a node already in a swarm
 * returns the current state rather than erroring (mirrors the installer's
 * idempotency guarantee).
 */
import type { DockerClient } from '@swarmy/core/docker';
import type { SwarmJoinPayload, SwarmJoinResult } from '@swarmy/core/protocol';

/**
 * Local source address the kernel would use to reach `host` — a connected UDP
 * socket makes the routing decision without sending a packet. Docker refuses
 * `swarm init` with no advertise addr on multi-homed boxes (public + private
 * NIC is the NORMAL VPS shape), so when the controller doesn't pin one we
 * default to the interface that actually reaches the fabric: the controller
 * for init, the manager for join.
 */
export async function localAddrToward(host: string, port = 53): Promise<string | undefined> {
  try {
    const s = await Bun.udpSocket({ connect: { hostname: host, port } });
    const addr = s.address.address;
    s.close();
    return addr && addr !== '0.0.0.0' ? addr : undefined;
  } catch {
    return undefined;
  }
}

/** Host part of AGENT_WS_URL — the "toward the controller" routing anchor. */
function controllerHost(): string | undefined {
  const raw = process.env.AGENT_WS_URL;
  if (!raw) return undefined;
  try {
    return new URL(raw).hostname || undefined;
  } catch {
    return undefined;
  }
}

export async function applySwarmJoin(
  docker: DockerClient,
  p: SwarmJoinPayload,
): Promise<SwarmJoinResult> {
  if (p.mode === 'init') {
    const advertiseAddr =
      p.advertiseAddr ?? (await localAddrToward(controllerHost() ?? '1.1.1.1'));
    const { swarmNodeId, managerAddr, joinTokens } = await docker.swarmInit(advertiseAddr);
    return { mode: 'init', swarmNodeId, managerAddr, joinTokens };
  }

  // mode === 'join' — payload validation (superRefine) guarantees these exist.
  if (!p.joinToken || !p.managerAddr) {
    throw new Error('swarmJoin: join mode requires joinToken and managerAddr');
  }
  const advertiseAddr =
    p.advertiseAddr ?? (await localAddrToward(p.managerAddr.split(':')[0] ?? '1.1.1.1'));
  const { swarmNodeId } = await docker.swarmJoin({
    managerAddr: p.managerAddr,
    joinToken: p.joinToken,
    advertiseAddr,
  });
  return { mode: 'join', swarmNodeId };
}
