import { z } from 'zod';
import { CommandId } from './primitives';

/** Wire-level driver name. Mirrors the DB `IngressDriver` enum (lowercased). */
export const IngressDriverName = z.enum(['caddy', 'traefik', 'none']);
export type IngressDriverName = z.infer<typeof IngressDriverName>;

/**
 * A single host → service route. `tls` is tri-state so a driver can do
 * automatic ACME (`auto`), no TLS (`off`), or operator-supplied certs (`custom`).
 */
export const DomainRoute = z.object({
  domain: z.string().min(1),
  serviceName: z.string().min(1),
  targetPort: z.number().int().positive(),
  tls: z.enum(['auto', 'off', 'custom']).default('auto'),
  pathPrefix: z.string().optional(),
  stripPathPrefix: z.boolean().default(false),
  middlewares: z.array(z.string()).default([]),
});
export type DomainRoute = z.infer<typeof DomainRoute>;

/** A config file the agent should write on the node. */
export const RenderedFile = z.object({
  path: z.string(),
  contents: z.string(),
  /** POSIX mode, e.g. 0o644 — agent applies it when writing. */
  mode: z.number().int().optional(),
});
export type RenderedFile = z.infer<typeof RenderedFile>;

/** Docker labels a driver wants set on a swarm service (e.g. Traefik). */
export const ServiceLabels = z.object({
  serviceName: z.string(),
  labels: z.record(z.string()),
});
export type ServiceLabels = z.infer<typeof ServiceLabels>;

/**
 * The full output of an ingress driver's `render()`. Produced by
 * `@swarmy/ingress`, carried verbatim to the agent inside `applyIngress`.
 */
export const RenderedConfig = z.object({
  driver: IngressDriverName,
  files: z.array(RenderedFile).default([]),
  serviceLabels: z.array(ServiceLabels).default([]),
  /** Command the agent runs after writing files, e.g. `["caddy","reload"]`. */
  reloadCommand: z.array(z.string()).optional(),
  /** Or reload via an admin HTTP API instead of a shell command. */
  adminApi: z
    .object({
      url: z.string(),
      method: z.enum(['POST', 'PUT', 'PATCH']).default('POST'),
      body: z.string().optional(),
      contentType: z.string().optional(),
    })
    .optional(),
  /** Human-readable one-liner for the UI / audit log. */
  summary: z.string(),
});
export type RenderedConfig = z.infer<typeof RenderedConfig>;

export const IngressStatus = z.object({
  driver: IngressDriverName,
  healthy: z.boolean(),
  message: z.string().optional(),
  routeCount: z.number().int().nonnegative(),
  lastAppliedAt: z.number().int().optional(),
});
export type IngressStatus = z.infer<typeof IngressStatus>;

export const ApplyIngressPayload = z.object({
  commandId: CommandId,
  timeoutMs: z.number().int().positive().optional(),
  rendered: RenderedConfig,
});
export type ApplyIngressPayload = z.infer<typeof ApplyIngressPayload>;

export const ApplyIngressMsg = z.object({
  type: z.literal('applyIngress'),
  payload: ApplyIngressPayload,
});
export type ApplyIngressMsg = z.infer<typeof ApplyIngressMsg>;
