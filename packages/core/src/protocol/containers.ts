import { z } from 'zod';
import { Timestamp } from './primitives';

export const ContainerState = z.enum([
  'created',
  'running',
  'paused',
  'restarting',
  'removing',
  'exited',
  'dead',
]);
export type ContainerState = z.infer<typeof ContainerState>;

export const ContainerPort = z.object({
  ip: z.string().optional(),
  privatePort: z.number().int(),
  publicPort: z.number().int().optional(),
  protocol: z.enum(['tcp', 'udp', 'sctp']),
});
export type ContainerPort = z.infer<typeof ContainerPort>;

export const ContainerInfo = z.object({
  id: z.string(),
  name: z.string(),
  image: z.string(),
  imageId: z.string().optional(),
  state: ContainerState,
  status: z.string(), // human "Up 3 hours"
  createdAt: Timestamp,
  ports: z.array(ContainerPort),
  labels: z.record(z.string()),
  /** Swarm task → service link, when present. */
  serviceId: z.string().optional(),
});
export type ContainerInfo = z.infer<typeof ContainerInfo>;

export const ContainerListPayload = z.object({
  snapshotAt: Timestamp,
  containers: z.array(ContainerInfo),
});
export type ContainerListPayload = z.infer<typeof ContainerListPayload>;

export const ContainerListMsg = z.object({
  type: z.literal('containerList'),
  payload: ContainerListPayload,
});
export type ContainerListMsg = z.infer<typeof ContainerListMsg>;

/** Swarm service info — only managers can enumerate these. */
export const SwarmServiceInfo = z.object({
  id: z.string(),
  name: z.string(),
  image: z.string(),
  mode: z.enum(['replicated', 'global']),
  desiredReplicas: z.number().int().nonnegative().optional(),
  runningReplicas: z.number().int().nonnegative(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  updateStatus: z
    .enum(['none', 'updating', 'paused', 'completed', 'rollback_started', 'rollback_completed'])
    .optional(),
  labels: z.record(z.string()),
  /** Attached overlay networks (resolved names + aliases) — drives link inference. */
  networks: z
    .array(z.object({ name: z.string(), aliases: z.array(z.string()).default([]) }))
    .default([]),
  /** TaskTemplate env (`KEY=value` strings) — drives env-ref link inference. */
  env: z.array(z.string()).default([]),
  /** Published ports (target/published/protocol). */
  ports: z
    .array(
      z.object({
        target: z.number().int(),
        published: z.number().int().optional(),
        protocol: z.enum(['tcp', 'udp']).default('tcp'),
      }),
    )
    .default([]),
  /** Docker secret NAMES the service spec references — drives the secrets-mgr
   *  usage map/rotation (E1). References only, never values. Defaults keep the
   *  wire optional-safe for older agents. */
  secrets: z.array(z.string()).default([]),
  /** Docker config NAMES the service spec references (configs-mgr, E2). */
  configs: z.array(z.string()).default([]),
});
export type SwarmServiceInfo = z.infer<typeof SwarmServiceInfo>;

/**
 * Local swarm membership of the reporting node, straight from `docker info`'s
 * `Swarm.LocalNodeState`. Only `active` means the node is a working swarm member
 * that can run workloads; anything else (the operator ran `docker swarm leave`,
 * the node is mid-join, or the swarm is locked) makes the node unusable even
 * though its agent WebSocket is still connected. The controller must not treat a
 * connected-but-inactive node as a healthy manager.
 */
export const SwarmState = z.enum(['active', 'pending', 'locked', 'error', 'inactive']);
export type SwarmState = z.infer<typeof SwarmState>;

export const ServiceStatePayload = z.object({
  snapshotAt: Timestamp,
  isManager: z.boolean(),
  /** Live local swarm membership; absent from legacy agents ⇒ assume active. */
  swarmState: SwarmState.optional(),
  services: z.array(SwarmServiceInfo),
});
export type ServiceStatePayload = z.infer<typeof ServiceStatePayload>;

/**
 * Graceful departure notice: the agent sends this the moment its swarm-membership
 * watchdog sees the node has left the swarm, just before it exits. Lets the
 * controller react intentionally (mark the node left-swarm, audit it, fan out to
 * alerts/incidents/re-placement) instead of inferring it from a bare WS drop.
 */
export const SwarmLeftPayload = z.object({
  at: Timestamp,
  /** The observed non-active local swarm state (usually `inactive`). */
  swarmState: SwarmState,
  /** Short human reason, e.g. `watchdog: docker swarm left`. */
  reason: z.string().optional(),
});
export type SwarmLeftPayload = z.infer<typeof SwarmLeftPayload>;

export const SwarmLeftMsg = z.object({
  type: z.literal('swarmLeft'),
  payload: SwarmLeftPayload,
});
export type SwarmLeftMsg = z.infer<typeof SwarmLeftMsg>;

export const ServiceStateMsg = z.object({
  type: z.literal('serviceState'),
  payload: ServiceStatePayload,
});
export type ServiceStateMsg = z.infer<typeof ServiceStateMsg>;

/** Swarm node info (`docker node ls/inspect`) — only managers can enumerate these.
 *  This is the Docker-truth replacement for the DB Node model's swarm fields. */
export const SwarmNodeInfo = z.object({
  swarmNodeId: z.string(),
  hostname: z.string(),
  role: z.enum(['manager', 'worker']),
  /** Swarm availability (`active`/`pause`/`drain`). */
  availability: z.enum(['active', 'pause', 'drain']),
  /** Node state from the cluster's perspective. */
  status: z.enum(['unknown', 'down', 'ready', 'disconnected']),
  leader: z.boolean().default(false),
  reachability: z.enum(['unknown', 'unreachable', 'reachable']).optional(),
  addr: z.string().optional(),
  engineVersion: z.string().optional(),
  os: z.string().optional(),
  arch: z.string().optional(),
  cpus: z.number().optional(),
  memBytes: z.number().optional(),
  labels: z.record(z.string()).default({}),
});
export type SwarmNodeInfo = z.infer<typeof SwarmNodeInfo>;

export const NodeListPayload = z.object({
  snapshotAt: Timestamp,
  nodes: z.array(SwarmNodeInfo),
});
export type NodeListPayload = z.infer<typeof NodeListPayload>;

export const NodeListMsg = z.object({
  type: z.literal('nodeList'),
  payload: NodeListPayload,
});
export type NodeListMsg = z.infer<typeof NodeListMsg>;
