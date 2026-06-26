/**
 * Display/view types returned by tRPC to the dashboard. Plain TS interfaces
 * (no Zod) — these are controller→browser shapes, distinct from the wire
 * protocol's agent→controller frames.
 */

export type NodeRole = 'manager' | 'worker';
export type NodeStatusView = 'pending' | 'online' | 'offline' | 'draining';
export type ServiceStatusView =
  | 'pending'
  | 'deploying'
  | 'running'
  | 'degraded'
  | 'stopped'
  | 'failed'
  | 'removing';
export type DeployPhase =
  | 'queued'
  | 'pulling'
  | 'creating'
  | 'converging'
  | 'complete'
  | 'failed'
  | 'rolledback'
  | 'canceled';

export interface NodeSummary {
  id: string;
  name: string;
  hostname: string;
  role: NodeRole;
  status: NodeStatusView;
  engineVersion: string | null;
  os: string | null;
  arch: string | null;
  resources: { cpus: number | null; memBytes: number | null };
  agentVersion: string | null;
  lastSeenAt: string | null;
  /** Most recent live snapshot, if the node is connected. */
  live: { cpuPercent: number; memPercent: number } | null;
}

export interface NodeDetail extends NodeSummary {
  ipAddress: string | null;
  swarmNodeId: string | null;
  labels: Record<string, string>;
  joinedAt: string;
}

export interface NodeStatsSnapshot {
  nodeId: string;
  ts: number;
  cpuPercent: number;
  cpuCount: number;
  memUsedBytes: number;
  memTotalBytes: number;
  netRxBytes: number;
  netTxBytes: number;
  fsUsedBytes: number | null;
  fsTotalBytes: number | null;
}

export interface ContainerStatsSnapshot {
  containerId: string;
  name: string;
  cpuPercent: number;
  memUsedBytes: number;
  memLimitBytes: number;
  netRxBytes: number;
  netTxBytes: number;
}

export interface ClusterStatsFrame {
  ts: number;
  nodesOnline: number;
  nodesTotal: number;
  cpuPercent: number;
  memUsedBytes: number;
  memTotalBytes: number;
  containersRunning: number;
}

export interface ServiceReplicas {
  desired: number;
  running: number;
}

export interface ServiceSummary {
  id: string;
  name: string;
  image: string;
  status: ServiceStatusView;
  replicas: ServiceReplicas;
  ingressEnabled: boolean;
  nodeId: string | null;
  stackId: string | null;
  updatedAt: string;
}

export interface ServiceDetail extends ServiceSummary {
  env: Record<string, string>;
  ports: Array<{ target: number; published?: number; protocol: string; mode: string }>;
  volumes: Array<{ type: string; source?: string; target: string; readOnly: boolean }>;
  networks: string[];
  constraints: string[];
  swarmServiceId: string | null;
  createdAt: string;
}

/** Live swarm state for a service, read from the gateway's in-memory snapshot. */
export interface ServiceStateSnapshot {
  serviceName: string;
  desiredReplicas: number | null;
  runningReplicas: number;
  updateStatus: string | null;
}

export interface DeployStatus {
  deploymentId: string;
  serviceId: string | null;
  kind: string;
  phase: DeployPhase;
  desired: number | null;
  ready: number | null;
  message: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface LogLine {
  seq: number;
  stream: 'stdout' | 'stderr';
  ts: number | null;
  message: string;
}

export interface TaskState {
  id: string;
  nodeId: string | null;
  state: string;
  desiredState: string;
  error: string | null;
}

export interface DashboardSummary {
  nodes: { online: number; total: number };
  services: { running: number; total: number };
  containersRunning: number;
  recentDeployments: number;
  cpuPercent: number;
  memPercent: number;
}
