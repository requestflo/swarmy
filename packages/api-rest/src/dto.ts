/**
 * Public REST DTOs — deliberately decoupled from `@swarmy/core` views so the
 * internal view can change without breaking the public contract (the handler
 * absorbs the mapping). Request bodies reuse `@swarmy/core/inputs` where the
 * public shape should match (the anti-duplication win).
 */
import { z } from '@hono/zod-openapi';

export const ProblemDto = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number(),
    detail: z.string().optional(),
    instance: z.string().optional(),
    swarmy_code: z.string().optional(),
  })
  .openapi('Problem');

export const NodeDto = z
  .object({
    id: z.string(),
    name: z.string(),
    hostname: z.string(),
    role: z.enum(['manager', 'worker']),
    status: z.enum(['pending', 'online', 'offline', 'draining']),
    engine_version: z.string().nullable(),
    os: z.string().nullable(),
    arch: z.string().nullable(),
    last_seen_at: z.string().nullable(),
  })
  .openapi('Node');

export const ServiceDto = z
  .object({
    id: z.string(),
    name: z.string(),
    image: z.string(),
    status: z.string(),
    replicas: z.object({ desired: z.number(), running: z.number() }),
    ingress_enabled: z.boolean(),
    node_id: z.string().nullable(),
    stack_id: z.string().nullable(),
    updated_at: z.string(),
  })
  .openapi('Service');

export const StackDto = z
  .object({
    id: z.string(),
    name: z.string(),
    service_count: z.number(),
    status: z.string(),
    updated_at: z.string(),
  })
  .openapi('Stack');

export const DomainDto = z
  .object({
    id: z.string(),
    host: z.string(),
    service_id: z.string(),
    service_name: z.string(),
    target_port: z.number(),
    tls: z.enum(['auto', 'off', 'custom']),
    path_prefix: z.string().nullable(),
  })
  .openapi('IngressDomain');

export const DeploymentRefDto = z
  .object({
    id: z.string(),
    deployment_id: z.string(),
  })
  .openapi('DeploymentRef');

export const RemovedDto = z
  .object({ id: z.string(), removed: z.literal(true) })
  .openapi('Removed');

/** Cursor pagination envelope factory. */
export function listEnvelope<T extends z.ZodTypeAny>(item: T, name: string) {
  return z
    .object({
      data: z.array(item),
      next_cursor: z.string().nullable(),
    })
    .openapi(name);
}

// ---- Request bodies (public REST shapes) ----

export const CreateServiceBody = z
  .object({
    name: z.string(),
    image: z.string(),
    replicas: z.number().int().min(0).max(1000).optional(),
    command: z.array(z.string()).optional(),
    env: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
    node_id: z.string().optional(),
  })
  .openapi('CreateServiceRequest');

export const ScaleBody = z
  .object({ replicas: z.number().int().min(0).max(1000) })
  .openapi('ScaleServiceRequest');

export const DeployStackBody = z
  .object({ name: z.string(), compose_source: z.string() })
  .openapi('DeployStackRequest');

export const AddDomainBody = z
  .object({
    host: z.string(),
    service_id: z.string(),
    target_port: z.number().int().min(1).max(65535),
    tls: z.enum(['auto', 'off', 'custom']).optional(),
    path_prefix: z.string().optional(),
  })
  .openapi('AddDomainRequest');
