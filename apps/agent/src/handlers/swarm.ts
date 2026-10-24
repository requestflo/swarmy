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
import type {
  SwarmJoinPayload,
  SwarmJoinResult,
  SwarmRotateTokensPayload,
  SwarmRotateTokensResult,
  SwarmSetAutolockPayload,
  SwarmSetAutolockResult,
} from '@swarmy/core/protocol';
import { agentOnHostNetwork, controllerHost, defaultAdvertiseAddr } from './swarm-advertise';

export { localAddrToward } from './swarm-advertise';

/** Whether this agent's routes are the host's (swarm-advertise.ts); injectable for tests. */
export type HostNetworkProbe = () => Promise<boolean>;

/**
 * True while a `rejoin` is between `swarm leave` and `swarm join`. The daemon's
 * swarm watchdog reads it so a deliberate re-pin (mesh migration) is not
 * mistaken for the node falling off the swarm — which would exit the agent
 * mid-command.
 */
let rejoinInFlight = false;
export function swarmRejoinInFlight(): boolean {
  return rejoinInFlight;
}

async function waitSwarmState(docker: DockerClient, want: 'inactive', timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await docker.swarmState()) === want) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`swarmJoin(rejoin): node did not reach swarm state ${want} in ${timeoutMs}ms`);
}

/**
 * Re-pin an existing member onto a new advertise / data-path address: leave
 * (never forced — Docker refuses on a manager, so demote first), then join.
 * Idempotent: a node already active on the target address is left alone, so
 * a controller that died mid-move can safely resend it.
 */
async function rejoinSwarm(
  docker: DockerClient,
  p: SwarmJoinPayload & { joinToken: string; managerAddr: string },
  onHostNetwork: boolean,
): Promise<SwarmJoinResult> {
  const advertiseAddr = p.advertiseAddr ?? (await defaultAdvertiseAddr(controllerHost() ?? '1.1.1.1', onHostNetwork));
  const state = await docker.swarmState();
  if (state === 'active') {
    const current = (await docker.localSwarmAddr()).replace(/:\d+$/, '');
    if (advertiseAddr && current === advertiseAddr) {
      const { swarmNodeId } = await docker.swarmJoin({ managerAddr: p.managerAddr, joinToken: p.joinToken });
      return { mode: 'join', swarmNodeId };
    }
  }
  rejoinInFlight = true;
  try {
    if (state !== 'inactive') {
      await docker.swarmLeave();
      await waitSwarmState(docker, 'inactive');
    }
    const { swarmNodeId } = await docker.swarmJoin({
      managerAddr: p.managerAddr,
      joinToken: p.joinToken,
      advertiseAddr,
      dataPathAddr: p.dataPathAddr,
    });
    return { mode: 'join', swarmNodeId };
  } finally {
    rejoinInFlight = false;
  }
}

export async function applySwarmJoin(
  docker: DockerClient,
  p: SwarmJoinPayload,
  hostNetwork: HostNetworkProbe = () => agentOnHostNetwork(docker),
): Promise<SwarmJoinResult> {
  if (p.mode === 'init' && p.refreshOnly) {
    // Read-only token refresh: never `swarm init` here — a node that isn't an
    // active manager must fail loudly rather than found a second swarm.
    const info = (await docker.docker.info()) as { Swarm?: { LocalNodeState?: string; ControlAvailable?: boolean } };
    if (info.Swarm?.LocalNodeState !== 'active' || info.Swarm?.ControlAvailable !== true) {
      throw new Error('swarmJoin(refreshOnly): this node is not an active swarm manager');
    }
    const { swarmNodeId, managerAddr, joinTokens } = await docker.readSwarmState();
    return { mode: 'init', swarmNodeId, managerAddr, joinTokens };
  }
  if (p.mode === 'init') {
    const advertiseAddr =
      p.advertiseAddr ?? (await defaultAdvertiseAddr(controllerHost() ?? '1.1.1.1', await hostNetwork()));
    const { swarmNodeId, managerAddr, joinTokens } = await docker.swarmInit(advertiseAddr);
    return { mode: 'init', swarmNodeId, managerAddr, joinTokens };
  }

  // mode === 'join' — payload validation (superRefine) guarantees these exist.
  if (!p.joinToken || !p.managerAddr) {
    throw new Error('swarmJoin: join mode requires joinToken and managerAddr');
  }
  const onHostNetwork = p.advertiseAddr ? true : await hostNetwork();
  if (p.rejoin) return rejoinSwarm(docker, { ...p, joinToken: p.joinToken, managerAddr: p.managerAddr }, onHostNetwork);
  const advertiseAddr =
    p.advertiseAddr ?? (await defaultAdvertiseAddr(p.managerAddr.split(':')[0] ?? '1.1.1.1', onHostNetwork));
  const { swarmNodeId } = await docker.swarmJoin({
    managerAddr: p.managerAddr,
    joinToken: p.joinToken,
    advertiseAddr,
    dataPathAddr: p.dataPathAddr,
  });
  return { mode: 'join', swarmNodeId };
}

/**
 * WS2 quorum recovery — thin pass-throughs over DockerClient (both are
 * manager-only; Docker rejects them elsewhere with a clear error the `run`
 * helper surfaces as a failed commandResult).
 */
export async function setSwarmAutolock(
  docker: DockerClient,
  p: SwarmSetAutolockPayload,
): Promise<SwarmSetAutolockResult> {
  return docker.swarmSetAutolock(p.enabled);
}

export async function rotateSwarmTokens(
  docker: DockerClient,
  p: SwarmRotateTokensPayload,
): Promise<SwarmRotateTokensResult> {
  return { joinTokens: await docker.swarmRotateTokens(p.roles) };
}
