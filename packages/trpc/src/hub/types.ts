import type { ContainerInfo } from '@swarmy/core/protocol';
import type {
  ClusterStatsFrame,
  ContainerStatsSnapshot,
  LogLine,
  NodeStatsSnapshot,
  ServiceStateSnapshot,
} from '@swarmy/core/views';

/**
 * Command names the controller dispatches to an agent. Reads (list/inspect/
 * stats) are NOT commands — they are served from the hub's in-memory snapshots.
 */
export type CommandName =
  | 'service.deploy' // create + update (idempotent)
  | 'service.scale'
  | 'service.restart'
  | 'service.remove'
  | 'image.pull'
  | 'applyIngress'
  | 'node.update' // cordon / drain / labels
  | 'logs.subscribe'
  | 'logs.unsubscribe'
  | 'exec';

/** CommandName → wire protocol message `type` (see @swarmy/core/protocol). */
export const COMMAND_PROTOCOL_TYPE: Record<CommandName, string> = {
  'service.deploy': 'deployService',
  'service.scale': 'scaleService',
  'service.restart': 'restartService',
  'service.remove': 'removeService',
  'image.pull': 'pullImage',
  applyIngress: 'applyIngress',
  'node.update': 'updateSwarmNode',
  'logs.subscribe': 'streamLogs',
  'logs.unsubscribe': 'streamLogs',
  exec: 'execCommand',
};

export interface CommandResult<R = unknown> {
  id: string;
  ok: boolean;
  data?: R;
  error?: { code: string; message: string };
  ts: number;
}

/**
 * The agent WebSocket hub. The concrete implementation lives in apps/api (it
 * owns the WS server); this interface is injected into tRPC context so the
 * services layer can dispatch commands and read live snapshots.
 */
export interface AgentHub {
  isOnline(nodeId: string): boolean;
  onlineNodeIds(): string[];

  /** Send a command to one node and await its correlated result. */
  dispatch<R = unknown>(
    nodeId: string,
    cmd: CommandName,
    payload: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<R>;

  /** Stream frames (logs) until the signal aborts. */
  stream<T>(
    nodeId: string,
    cmd: CommandName,
    payload: unknown,
    signal: AbortSignal,
  ): AsyncIterable<T>;

  latestNodeStats(nodeId: string): NodeStatsSnapshot | undefined;
  latestContainers(nodeId: string): ContainerInfo[];
  latestContainerStats(nodeId: string): ContainerStatsSnapshot[];
  latestServiceState(orgId: string): ServiceStateSnapshot[];

  subscribeNodeStats(nodeId: string, signal: AbortSignal): AsyncIterable<NodeStatsSnapshot>;
  subscribeClusterStats(orgId: string, signal: AbortSignal): AsyncIterable<ClusterStatsFrame>;
  subscribeLogLines(
    nodeId: string,
    payload: unknown,
    signal: AbortSignal,
  ): AsyncIterable<LogLine>;
}
