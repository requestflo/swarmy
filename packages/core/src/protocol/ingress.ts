import { z } from 'zod';
import { CommandId } from './primitives';

/** Wire-level driver name. Mirrors the DB `IngressDriver` enum (lowercased). */
export const IngressDriverName = z.enum(['caddy', 'traefik', 'none', 'cloudflared']);
export type IngressDriverName = z.infer<typeof IngressDriverName>;

/** A config file the agent should write on the node. */
export const RenderedFile = z.object({
  path: z.string(),
  contents: z.string(),
  /** POSIX mode, e.g. 0o644 — agent applies it when writing. */
  mode: z.number().int().default(0o644),
});
export type RenderedFile = z.infer<typeof RenderedFile>;

/** Docker labels a driver wants set on a swarm service (e.g. Traefik). */
export const ServiceLabels = z.object({
  service: z.string(),
  labels: z.record(z.string()),
  /** Previously-managed label keys to delete (drift cleanup). */
  removeLabelKeys: z.array(z.string()).default([]),
});
export type ServiceLabels = z.infer<typeof ServiceLabels>;

/**
 * The full output of an ingress driver's `render()`. Produced by
 * `@swarmy/ingress`, carried verbatim to the agent inside `applyIngress`.
 * The agent writes `files`, sets `serviceLabels`, then runs `reloadCommand`
 * OR calls `adminApi` (whichever the driver provided).
 */
export const RenderedConfig = z.object({
  driver: z.string(),
  files: z.array(RenderedFile).default([]),
  reloadCommand: z.array(z.string()).optional(),
  adminApi: z
    .object({
      method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
      url: z.string(),
      body: z.string().optional(),
      contentType: z.string().default('application/json'),
    })
    .optional(),
  serviceLabels: z.array(ServiceLabels).default([]),
  /** Human-inspectable summary for the previewConfig UI. */
  summary: z.string().default(''),
});
export type RenderedConfig = z.infer<typeof RenderedConfig>;

export const IngressCertInfo = z.object({
  domain: z.string(),
  issuer: z.string().optional(),
  notAfter: z.string().optional(),
  valid: z.boolean(),
});
export type IngressCertInfo = z.infer<typeof IngressCertInfo>;

export const IngressStatus = z.object({
  driver: z.string(),
  healthy: z.boolean(),
  version: z.string().optional(),
  activeDomains: z.array(z.string()).default([]),
  certs: z.array(IngressCertInfo).default([]),
  lastAppliedAt: z.string().optional(),
  message: z.string().optional(),
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
