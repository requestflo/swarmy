import { agentSupports, type AgentCapability } from '@swarmy/core/protocol';

/**
 * Which server reads inside a volume backup (browse + download). Pure.
 *
 * A node-path destination lives on ONE server's disk: only the server that
 * took the save can read it. An S3-shaped one (external S3, the native
 * Garage store) can be read from anywhere; the server that took it is
 * preferred, then any manager. Either way the agent must advertise the
 * capability: an older agent would drop the frame and the dashboard would
 * only see a timeout.
 */

export type ReadNodePick = { nodeId: string } | { refuse: string };

export function pickReadNode(i: {
  repoKind: 's3' | 'node';
  hostNodeId: string | null;
  managerIds: readonly string[];
  isOnline: (nodeId: string) => boolean;
  capabilities: (nodeId: string) => readonly string[] | undefined;
  cap: AgentCapability;
}): ReadNodePick {
  const tooOld = 'The server that would read this save runs an agent too old to look inside backups. Update its agent from Servers, then try again.';
  if (i.repoKind === 'node') {
    if (!i.hostNodeId) return { refuse: 'This save sits on one server’s disk, and swarmy doesn’t know which one any more.' };
    if (!i.isOnline(i.hostNodeId)) return { refuse: 'This save sits on the disk of a server that is offline right now. Bring it back, then try again.' };
    return agentSupports(i.capabilities(i.hostNodeId), i.cap) ? { nodeId: i.hostNodeId } : { refuse: tooOld };
  }
  const candidates = [...new Set([i.hostNodeId, ...i.managerIds].filter((n): n is string => !!n))].filter(i.isOnline);
  if (candidates.length === 0) return { refuse: 'No server is online to read this save.' };
  const able = candidates.find((n) => agentSupports(i.capabilities(n), i.cap));
  return able ? { nodeId: able } : { refuse: tooOld };
}
