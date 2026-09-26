import * as React from 'react';
import { CodeView, curl, restExchange } from '@/components/calm';
import { DOH_RESOLVERS } from '@swarmy/core';
import type { DomainDetail } from '@/components/ingress/domain-state';

/** The controller's resolver setting, as it would be written out (the default list, spelled out). */
function dohEnv(d: DomainDetail): string {
  const asked = (d.dns?.resolvers ?? []).filter((r) => r.tier === 'public').map((r) => r.id);
  const ids = asked.length ? asked : DOH_RESOLVERS.map((r) => r.id);
  const lines = DOH_RESOLVERS.map((r) => `#   ${r.id.padEnd(11)} ${r.format.padEnd(5)} ${r.url}`);
  return [
    '# Controller environment: the public DNS-over-HTTPS resolvers the domain check asks.',
    '# Unset = all 12 presets below. off / none / empty = no public resolvers',
    '# (swarmy’s own resolver and swarmy-dns decide). A custom https URL uses the',
    '# JSON API; prefix wire: for an RFC 8484 endpoint.',
    '# Go live when ≥ 3 of every 4 that answer point at your edges, with',
    '# 1.1.1.1 (cloudflare) and 8.8.8.8 (google) among them when configured.',
    ...lines,
    `SWARMY_DOH_RESOLVERS=${ids.join(',')}`,
  ].join('\n');
}

/** Code depth of the verification view: the same status and check over REST (snake_case, as the API returns it). */
export function VerifyCode({ d, routeId }: { d: DomainDetail; routeId: string | null }): React.JSX.Element {
  const id = encodeURIComponent(routeId ?? `<service id>:${d.host}`);
  const rec = (r: DomainDetail['guidance']['records'][number]) => ({ type: r.type, name: r.name, label: r.label, value: r.value, note: r.note });
  const status = {
    host: d.host,
    state: d.state,
    reason: d.reason,
    warnings: d.warnings,
    gated: d.gated,
    verified_at: d.verifiedAt,
    verified_manually: d.verifiedManually,
    last_checked_at: d.lastCheckedAt,
    next_check_at: d.nextCheckAt,
    dns: d.dns
      ? {
          a: d.dns.a,
          aaaa: d.dns.aaaa,
          cname: d.dns.cname,
          matched: d.dns.matched,
          resolvers: d.dns.resolvers.map((r) => ({ ...r })),
          gate: d.dns.gate
            ? (({ anchorsAgree, ...g }) => ({ ...g, anchors_agree: anchorsAgree }))(d.dns.gate)
            : null,
        }
      : null,
    certificate: d.certificate
      ? { issuer: d.certificate.issuer, expires_at: d.certificate.expiresAt, error: d.certificate.error, edges: d.certificate.edges, checked_at: d.certificate.checkedAt }
      : null,
    guidance: { mode: d.guidance.mode, summary: d.guidance.summary, records: d.guidance.records.map(rec), alternatives: d.guidance.alternatives.map(rec) },
  };
  const rest = [
    restExchange('GET', `/ingress/domains/${id}/status`, status),
    '',
    '# check again now',
    curl('POST', `/ingress/domains/${id}/verify`),
  ].join('\n');
  return (
    <CodeView
      title="This domain as code"
      source="readonly"
      tabs={[
        { label: 'REST', code: rest },
        { label: 'controller env', code: dohEnv(d) },
      ]}
    />
  );
}
