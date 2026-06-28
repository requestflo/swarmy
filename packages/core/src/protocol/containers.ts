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
});
export type SwarmServiceInfo = z.infer<typeof SwarmServiceInfo>;

export const ServiceStatePayload = z.object({
  snapshotAt: Timestamp,
  isManager: z.boolean(),
  services: z.array(SwarmServiceInfo),
});
export type ServiceStatePayload = z.infer<typeof ServiceStatePayload>;

export const ServiceStateMsg = z.object({
  type: z.literal('serviceState'),
  payload: ServiceStatePayload,
});
export type ServiceStateMsg = z.infer<typeof ServiceStateMsg>;
