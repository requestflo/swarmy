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

export async function applySwarmJoin(
  docker: DockerClient,
  p: SwarmJoinPayload,
): Promise<SwarmJoinResult> {
  if (p.mode === 'init') {
    const { swarmNodeId, managerAddr, joinTokens } = await docker.swarmInit(p.advertiseAddr);
    return { mode: 'init', swarmNodeId, managerAddr, joinTokens };
  }

  // mode === 'join' — payload validation (superRefine) guarantees these exist.
  if (!p.joinToken || !p.managerAddr) {
    throw new Error('swarmJoin: join mode requires joinToken and managerAddr');
  }
  const { swarmNodeId } = await docker.swarmJoin({
    managerAddr: p.managerAddr,
    joinToken: p.joinToken,
    advertiseAddr: p.advertiseAddr,
  });
  return { mode: 'join', swarmNodeId };
}
