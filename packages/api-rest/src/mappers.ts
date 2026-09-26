/** Map internal `@swarmy/core` views / service results → public REST DTOs. */
import type { NodeSummary, ServiceSummary } from '@swarmy/core/views';
import type { StackSummary } from '@swarmy/trpc';
import type { DomainDetailView, DomainStatusView, DomainView } from '@swarmy/trpc';

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
    ...('lastError' in s ? { last_error: (s as { lastError?: string }).lastError ?? null } : {}),
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

export function domainStatusToDto(s: DomainStatusView) {
  return {
    host: s.host,
    state: s.state,
    reason: s.reason,
    warnings: s.warnings,
    gated: s.gated,
    verified_at: s.verifiedAt,
    verified_manually: s.verifiedManually,
    last_checked_at: s.lastCheckedAt,
    next_check_at: s.nextCheckAt,
    dns: s.dns
      ? {
          a: s.dns.a,
          aaaa: s.dns.aaaa,
          cname: s.dns.cname,
          matched: s.dns.matched,
          resolvers: s.dns.resolvers,
          gate: s.dns.gate
            ? {
                basis: s.dns.gate.basis,
                agreeing: s.dns.gate.agreeing,
                answering: s.dns.gate.answering,
                needed: s.dns.gate.needed,
                anchors: s.dns.gate.anchors,
                anchors_agree: s.dns.gate.anchorsAgree,
                pass: s.dns.gate.pass,
              }
            : null,
        }
      : null,
    certificate: s.certificate
      ? {
          issuer: s.certificate.issuer,
          expires_at: s.certificate.expiresAt,
          error: s.certificate.error,
          edges: s.certificate.edges,
          checked_at: s.certificate.checkedAt,
        }
      : null,
  };
}

export function domainDetailToDto(d: DomainDetailView) {
  return {
    ...domainStatusToDto(d),
    guidance: d.guidance,
    companion: d.companion ? domainStatusToDto(d.companion) : null,
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
    www: d.www,
    companion_host: d.companionHost,
    auto: d.auto,
    status: d.status ? domainStatusToDto(d.status) : null,
    companion_status: d.companionStatus ? domainStatusToDto(d.companionStatus) : null,
  };
}

/**
 * Service-layer `{ id, deploymentId }` → the declared `DeploymentRef`
 * (`{ id, deployment_id }`). `deployment_id` polls at `GET /deployments/{id}`.
 */
export function deploymentRefToDto(r: { id: string; deploymentId: string; deployId?: string }) {
  return { id: r.id, deployment_id: r.deploymentId, ...(r.deployId ? { deploy_id: r.deployId } : {}) };
}
