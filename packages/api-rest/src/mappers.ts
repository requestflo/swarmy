/** Map internal `@swarmy/core` views / service results → public REST DTOs. */
import type { NodeSummary, ServiceSummary } from '@swarmy/core/views';
import type { StackSummary } from '@swarmy/trpc';
import type { DomainView } from '@swarmy/trpc';

export function nodeToDto(n: NodeSummary) {
  return {
    id: n.id,
    name: n.name,
    hostname: n.hostname,
    role: n.role,
    status: n.status,
    engine_version: n.engineVersion,
    os: n.os,
    arch: n.arch,
    last_seen_at: n.lastSeenAt,
  };
}

export function serviceToDto(s: ServiceSummary) {
  return {
    id: s.id,
    name: s.name,
    image: s.image,
    status: s.status,
    replicas: { desired: s.replicas.desired, running: s.replicas.running },
    ingress_enabled: s.ingressEnabled,
    node_id: s.nodeId,
    stack_id: s.stackId,
    updated_at: s.updatedAt,
  };
}

export function stackToDto(s: StackSummary) {
  return {
    id: s.id,
    name: s.name,
    service_count: s.serviceCount,
    status: s.status,
    updated_at: s.updatedAt,
  };
}

export function domainToDto(d: DomainView) {
  return {
    id: d.id,
    host: d.host,
    service_id: d.serviceId,
    service_name: d.serviceName,
    target_port: d.targetPort,
    tls: d.tls,
    path_prefix: d.pathPrefix,
  };
}
