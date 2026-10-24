import { agentSkew, type AgentSkew, type NodeFacts } from '@swarmy/core/protocol';
import { VERSION } from '../version';

/**
 * Judge a registering agent's version skew against this controller. The
 * result rides the node's register facts in the gateway store (process
 * memory, re-judged on every register — never a DB column or a label), so the
 * dashboard can say "this server's agent is two versions behind". An agent
 * that shares no protocol version with us is logged as a warning: its frames
 * will not parse, so the node looks connected but does nothing.
 */
export function judgeAgentSkew(
  nodeId: string,
  facts: Pick<NodeFacts, 'hostname' | 'agentVersion'> & { protocolVersions: readonly number[] },
  controllerVersion: string = VERSION,
  warn: (msg: string) => void = console.warn,
): AgentSkew {
  const skew = agentSkew(controllerVersion, facts.agentVersion, facts.protocolVersions);
  if (skew.status === 'incompatible') {
    warn(
      `[gateway] node ${nodeId} (${facts.hostname}): agent ${facts.agentVersion} speaks protocol ` +
        `[${facts.protocolVersions.join(', ')}], controller ${controllerVersion} does not — upgrade the agent`,
    );
  }
  return skew;
}
