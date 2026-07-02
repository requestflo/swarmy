import type { ContainerInfo, SwarmServiceInfo, SwarmNodeInfo, TermTarget } from '@swarmy/core/protocol';
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
  | 'service.inspect'
  | 'service.updateLabels'
  | 'service.remove'
  | 'network.ensure' // idempotent overlay-network create (pre-deploy)
  | 'image.pull'
  | 'applyIngress'
  | 'applyMesh'
  | 'image.build'
  | 'node.update' // cordon / drain / labels
  | 'logs.subscribe'
  | 'logs.unsubscribe'
  | 'exec'
  | 'backup.run'
  | 'backup.restore'
  | 'backup.list'
  | 'db.backup' // data-plane: logical/physical DB backup (pg_dump/wal-g/…)
  | 'db.restore'
  | 'storage.apply' // volumes-dr P2: bring up a Garage member
  | 'volume.provision' // volumes-dr P3: create a local/CSI cluster volume
  | 'volume.remove'
  | 'image.prune'
  | 'mesh.grantDirectRoute'
  | 'swarm.join' // node-onboarding P2: init/join the org's Docker Swarm
  | 'secret.create' // platform buildout: Docker secrets/configs as first-class resources
  | 'secret.remove'
  | 'secret.list'
  | 'config.create'
  | 'config.remove'
  | 'config.list'
  | 'config.inspect'
  | 'container.runOnce'; // one-shot utility container → { exitCode, output }

/** CommandName → wire protocol message `type` (see @swarmy/core/protocol). */
export const COMMAND_PROTOCOL_TYPE: Record<CommandName, string> = {
  'service.deploy': 'deployService',
  'service.scale': 'scaleService',
  'service.restart': 'restartService',
  'service.inspect': 'inspectService',
  'service.updateLabels': 'updateServiceLabels',
  'service.remove': 'removeService',
  'network.ensure': 'ensureNetwork',
  'image.pull': 'pullImage',
  applyIngress: 'applyIngress',
  applyMesh: 'applyMesh',
  'image.build': 'buildImage',
  'node.update': 'updateSwarmNode',
  'logs.subscribe': 'streamLogs',
  'logs.unsubscribe': 'streamLogs',
  exec: 'execCommand',
  'backup.run': 'backupVolume',
  'backup.restore': 'restoreVolume',
  'backup.list': 'listSnapshots',
  'db.backup': 'dbBackup',
  'db.restore': 'dbRestore',
  'storage.apply': 'applyStorageNode',
  'volume.provision': 'provisionVolume',
  'volume.remove': 'removeVolume',
  'image.prune': 'pruneImages',
  'mesh.grantDirectRoute': 'grantDirectRoute',
  'swarm.join': 'swarmJoin',
  'secret.create': 'secretCreate',
  'secret.remove': 'secretRemove',
  'secret.list': 'secretList',
  'config.create': 'configCreate',
  'config.remove': 'configRemove',
  'config.list': 'configList',
  'config.inspect': 'configInspect',
  'container.runOnce': 'runOnce',
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
  /** Live Docker inventory (services + containers) read from the in-memory hub. */
  liveInventory(orgId: string): { services: SwarmServiceInfo[]; containers: ContainerInfo[] };
  /** A connected swarm-manager node id (Docker truth) to route write commands to. */
  managerNode(orgId: string): string | undefined;
  /** Live swarm node inventory (Docker-truth role/status/labels/resources) for the org.
   *  includeOffline folds in last-known nodes for disconnected-but-enrolled agents. */
  nodeInventory(orgId: string, includeOffline?: boolean): SwarmNodeInfo[];
  /** ALL connected swarm-manager node ids for the org (for fan-out / pick-any). */
  managerNodes(orgId: string): string[];
  /** Last-known services for the org (live + retained-on-disconnect) — dr-reconcile. */
  lastKnownServices(orgId: string): SwarmServiceInfo[];
  /** Last heartbeat time for a node (ms epoch), or undefined if never seen. */
  lastSeen(nodeId: string): number | undefined;
  /** Docker swarm node id for a connected agent (via its reported hostname). */
  swarmNodeIdFor(controllerNodeId: string): string | undefined;
  /** Full live swarm info (role/status/labels/resources) for an enrollment node id. */
  nodeInfoFor(controllerNodeId: string): SwarmNodeInfo | undefined;
  /** Controller node ids carrying a role label (swarmy.node.ingress/outlet = "true"). */
  nodesByRole(orgId: string, role: 'ingress' | 'outlet'): string[];
  /** Region label (swarmy.region) → controller node ids in that region. */
  nodesByRegion(orgId: string): Map<string, string[]>;

  subscribeNodeStats(nodeId: string, signal: AbortSignal): AsyncIterable<NodeStatsSnapshot>;
  subscribeClusterStats(orgId: string, signal: AbortSignal): AsyncIterable<ClusterStatsFrame>;
  subscribeLogLines(
    nodeId: string,
    payload: unknown,
    signal: AbortSignal,
  ): AsyncIterable<LogLine>;

  /** Mint a single-use ticket for the browser terminal data plane (/term/ws). */
  mintTerminalTicket(input: {
    sessionId: string;
    nodeId: string;
    orgId: string;
    userId: string;
    target: TermTarget;
  }): { ticket: string; expiresAt: number };

  /** Best-effort teardown of a live terminal session's data-plane socket. */
  killTerminalSession?(sessionId: string): boolean;
}
