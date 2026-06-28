import { z } from 'zod';

/**
 * Input schemas shared by the dashboard forms (react-hook-form resolver) and
 * the tRPC routers (`.input()`). One definition per concept — no drift.
 */

export const EnvVar = z.object({
  key: z
    .string()
    .regex(/^[A-Z_][A-Z0-9_]*$/, 'UPPER_SNAKE_CASE, starting with a letter or underscore'),
  value: z.string(),
});
export type EnvVar = z.infer<typeof EnvVar>;

export const PortMapping = z.object({
  target: z.number().int().min(1).max(65535),
  published: z.number().int().min(1).max(65535).optional(),
  protocol: z.enum(['tcp', 'udp']).default('tcp'),
  mode: z.enum(['ingress', 'host']).default('ingress'),
});
export type PortMapping = z.infer<typeof PortMapping>;

export const VolumeMount = z.object({
  type: z.enum(['volume', 'bind', 'tmpfs']).default('volume'),
  source: z.string().optional(),
  target: z.string().min(1),
  readOnly: z.boolean().default(false),
});
export type VolumeMount = z.infer<typeof VolumeMount>;

export const TlsMode = z.enum(['auto', 'off', 'custom']);
export type TlsMode = z.infer<typeof TlsMode>;

/** Per-service ingress fragment — creates/updates a Domain row. */
export const ServiceIngressInput = z.object({
  enabled: z.boolean().default(false),
  domain: z.string().optional(),
  targetPort: z.number().int().min(1).max(65535).optional(),
  tls: TlsMode.default('auto'),
  pathPrefix: z.string().optional(),
});
export type ServiceIngressInput = z.infer<typeof ServiceIngressInput>;

const serviceName = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9_.-]*$/, 'lowercase letters, digits, and _ . - only');

export const CreateServiceInput = z.object({
  name: serviceName,
  image: z.string().min(1),
  replicas: z.number().int().min(0).max(1000).default(1),
  command: z.array(z.string()).default([]),
  env: z.array(EnvVar).default([]),
  ports: z.array(PortMapping).default([]),
  volumes: z.array(VolumeMount).default([]),
  networks: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  /** Pin to a single node; omit for swarm-wide scheduling. */
  nodeId: z.string().optional(),
  /** Project = Docker stack namespace; groups the service on the canvas. */
  project: z.string().optional(),
  ingress: ServiceIngressInput.optional(),
});
export type CreateServiceInput = z.infer<typeof CreateServiceInput>;

export const UpdateServiceInput = CreateServiceInput.partial().extend({
  id: z.string(),
});
export type UpdateServiceInput = z.infer<typeof UpdateServiceInput>;

export const LogsInput = z.object({
  serviceId: z.string().optional(),
  containerId: z.string().optional(),
  tail: z.number().int().min(0).max(5000).default(200),
  follow: z.boolean().default(true),
  since: z.number().int().optional(),
});
export type LogsInput = z.infer<typeof LogsInput>;

export const CursorInput = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type CursorInput = z.infer<typeof CursorInput>;

export const MetricKind = z.enum(['cpu', 'mem', 'net', 'disk']);
export type MetricKind = z.infer<typeof MetricKind>;

export const TimeRange = z.enum(['5m', '15m', '1h', '6h', '24h', '7d']);
export type TimeRange = z.infer<typeof TimeRange>;

export const TimeseriesInput = z.object({
  nodeId: z.string().optional(),
  serviceId: z.string().optional(),
  containerId: z.string().optional(),
  metric: MetricKind.default('cpu'),
  range: TimeRange.default('1h'),
});
export type TimeseriesInput = z.infer<typeof TimeseriesInput>;
