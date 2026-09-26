import * as React from 'react';
import { CodeView, curl, restExchange } from '@/components/calm';
import type { DomainDetail } from '@/components/ingress/domain-state';

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
    dns: d.dns ? { a: d.dns.a, aaaa: d.dns.aaaa, cname: d.dns.cname, matched: d.dns.matched } : null,
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
  return <CodeView title="This domain as code" source="readonly" tabs={[{ label: 'REST', code: rest }]} />;
}
