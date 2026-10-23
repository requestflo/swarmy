import * as React from 'react';
import { CodeView, curl, restExchange } from '@/components/calm';
import type { DnsRecordView, DnsZoneView } from './geo-types';

/**
 * Code depth of Geo-DNS: the zone's manual records and the delegation check
 * over the public REST API (`/dns/zones/…`). Web records are derived, so they
 * have no text form to edit; TTL and location data are dashboard settings.
 */
export function GeoDnsCode({ zone, records }: { zone: DnsZoneView; records: DnsRecordView[] }): React.JSX.Element {
  const rest = [
    restExchange(
      'GET',
      `/dns/zones/${zone.id}/records`,
      records.map((r) => ({ id: r.id, name: r.name, type: r.type, value: r.value, ttl: r.ttl, priority: r.priority })),
    ),
    '',
    '# add one (upsert by name + type + value)',
    curl('POST', `/dns/zones/${zone.id}/records`, { name: '_dmarc', type: 'TXT', value: 'v=DMARC1; p=quarantine' }),
    '',
    '# the live delegation check',
    curl('GET', `/dns/zones/${zone.id}/delegation`),
  ].join('\n');
  const dig = [
    `# ask one of swarmy's nameservers directly`,
    ...zone.nameservers.slice(0, 1).flatMap((n) => [
      `dig @${n.ip || n.fqdn} ${zone.zone} A +short`,
      `dig @${n.ip || n.fqdn} ${zone.zone} SOA +short`,
      `# as a visitor in South Africa would (EDNS client subnet)`,
      `dig @${n.ip || n.fqdn} ${zone.zone} A +subnet=196.25.0.0/16 +short`,
    ]),
    `dig ${zone.zone} NS +short`,
  ].join('\n');
  return (
    <CodeView
      tabs={[
        { label: 'REST', code: rest },
        { label: 'dig', code: dig },
      ]}
      note="Records and the delegation check are the same calls over REST. The answer TTL and location data are dashboard settings."
    />
  );
}
