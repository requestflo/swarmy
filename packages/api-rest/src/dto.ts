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

const WwwMode = z
  .enum(['redirect-www-to-apex', 'redirect-apex-to-www', 'serve-both'])
  .openapi('IngressWwwMode', {
    description:
      'Apex ↔ www pairing for the host: serve the apex and 308 www onto it, serve www and 308 the apex onto it, or serve both.',
  });

/** Custom-domain lifecycle state (open enum — new values may be added). */
const DomainState = z.enum(['waiting_dns', 'verified', 'issuing', 'active', 'error']).openapi('IngressDomainState');

export const DomainStatusDto = z
  .object({
    host: z.string(),
    state: DomainState,
    reason: z.string().openapi({ description: 'One plain-words sentence explaining the state.' }),
    warnings: z.array(z.string()),
    gated: z.boolean().openapi({
      description: 'Withheld from the edge until DNS points at swarmy — no certificate is requested meanwhile.',
    }),
    verified_at: z.string().nullable(),
    verified_manually: z.boolean(),
    last_checked_at: z.string().nullable(),
    next_check_at: z.string().nullable(),
    dns: z
      .object({
        a: z.array(z.string()),
        aaaa: z.array(z.string()),
        cname: z.array(z.string()),
        matched: z.array(z.string()),
      })
      .nullable(),
    certificate: z
      .object({
        issuer: z.string().nullable(),
        expires_at: z.string().nullable(),
        error: z.string().nullable(),
        edges: z.array(z.object({ ip: z.string(), ok: z.boolean(), error: z.string().optional() })),
        checked_at: z.string().nullable(),
      })
      .nullable(),
  })
  .openapi('IngressDomainStatus');

const DnsRecordHintDto = z
  .object({
    type: z.enum(['A', 'AAAA', 'CNAME', 'NS']),
    name: z.string(),
    label: z.string().openapi({ description: 'What most registrar UIs want in the host box (`@`, `www`, `app`).' }),
    value: z.string(),
    note: z.string().optional(),
  })
  .openapi('DnsRecordHint');

export const DomainDetailDto = DomainStatusDto.extend({
  guidance: z.object({
    mode: z.enum(['records', 'zone', 'tunnel', 'private']),
    summary: z.string(),
    records: z.array(DnsRecordHintDto),
    alternatives: z.array(DnsRecordHintDto),
  }),
  companion: DomainStatusDto.nullable(),
}).openapi('IngressDomainDetail');

export const DomainDto = z
  .object({
    id: z.string().openapi({
      description: '`<serviceId>:<host>` (+ `/<path>` for a path route). URL-encode it in paths.',
    }),
    host: z.string(),
    service_id: z.string(),
    service_name: z.string(),
    target_port: z.number(),
    tls: z.enum(['auto', 'off', 'custom']),
    path_prefix: z.string().nullable(),
    www: WwwMode.nullable().optional(),
    companion_host: z.string().nullable().optional(),
    auto: z
      .boolean()
      .optional()
      .openapi({ description: "swarmy's automatic `<service>-<stack>.<edge-ip>.sslip.io` address." }),
    status: DomainStatusDto.nullable().optional(),
    companion_status: DomainStatusDto.nullable().optional(),
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
    www: WwwMode.optional(),
  })
  .openapi('AddDomainRequest');

export const UpdateDomainBody = z
  .object({ www: WwwMode.nullable() })
  .openapi('UpdateDomainRequest');
