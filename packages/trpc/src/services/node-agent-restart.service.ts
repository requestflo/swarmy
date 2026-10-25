/**
 * "Restart agent" (board 11): ask one server's agent to exit cleanly so what
 * runs it (systemd, Docker's restart policy, the swarm scheduler) starts it
 * again, then wait for its next register and say how long it was gone.
 * Workloads are not touched. The agent refuses (`E_NO_SUPERVISOR`) when
 * nothing would bring it back.
 *
 * Additive: only agents that advertise the `restartAgent` capability get the
 * command (and the button). Audited as `node.agent.restart`.
 */
import { AGENT_CAPABILITY, agentSupports, type AgentSupervisor, type RestartAgentResult } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { badRequest, mapDispatchError } from '../errors';
import { writeAudit } from './audit.service';
import { requireOnlineNode } from './dispatch.service';

export interface AgentRestartView {
  id: string;
  supervisor: AgentSupervisor;
  /** Click to the agent's next register; null = not back within the wait (it may still come). */
  backInMs: number | null;
}

export interface RestartWaitOptions {
  /** How long to wait for the next register (default 60 s). */
  waitMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Can this server's agent take the command? (An agent that predates it would drop the frame.) */
export function canRestartAgent(ctx: Pick<OrgContext, 'hub'>, nodeId: string): boolean {
  return agentSupports(ctx.hub.agentBuildFor?.(nodeId)?.capabilities, AGENT_CAPABILITY.restartAgent);
}

/** Wait for a register newer than `since`; resolves to its time, or null at the deadline. */
export async function waitForReRegister(
  ctx: Pick<OrgContext, 'hub'>,
  nodeId: string,
  since: number,
  o: RestartWaitOptions = {},
): Promise<number | null> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + (o.waitMs ?? 60_000);
  for (;;) {
    const at = ctx.hub.agentBuildFor?.(nodeId)?.registeredAt;
    if (at !== undefined && at > since && ctx.hub.isOnline(nodeId)) return at;
    if (now() >= deadline) return null;
    await sleep(o.pollMs ?? 250);
  }
}

export async function restartNodeAgent(ctx: OrgContext, id: string, o: RestartWaitOptions = {}): Promise<AgentRestartView> {
  const node = await requireOnlineNode(ctx, id);
  if (!canRestartAgent(ctx, node.id)) {
    throw badRequest('This server’s agent is too old to restart from here. Update the agent, or restart it on the server.');
  }
  const startedAt = (o.now ?? Date.now)();
  let result: RestartAgentResult;
  try {
    result = await ctx.hub.dispatch<RestartAgentResult>(node.id, 'agent.restart', {});
  } catch (e) {
    throw mapDispatchError(e);
  }
  await writeAudit(ctx, {
    action: 'node.agent.restart',
    targetType: 'node',
    targetId: node.id,
    metadata: { supervisor: result.supervisor },
  });
  const back = await waitForReRegister(ctx, node.id, startedAt, o);
  return { id: node.id, supervisor: result.supervisor, backInMs: back === null ? null : Math.max(0, back - startedAt) };
}
