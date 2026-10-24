import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { CalmRow, RowList } from '@/components/calm';
import { EmptyState } from '@/components/states';
import { GlobeIcon } from 'lucide-react';
import { perMinText } from './route-map/route-map-model';
import { useAddressVisits } from './use-address-visits';
import { domainSay, type HubDomain } from './use-network';
import { autoAddressLabel } from '@/lib/auto-address-label';

/**
 * One flat row per address: where it goes, whether HTTPS is on, its own
 * visits a minute at the edge (when the edge counts it), the tech line at Controls.
 */
export function DomainList({ domains }: { domains: HubDomain[] }): React.JSX.Element {
  const visitsOf = useAddressVisits();
  if (domains.length === 0) {
    return (
      <EmptyState
        icon={<GlobeIcon />}
        title="No addresses yet"
        description="Give an app its own address. swarmy gets the HTTPS certificate and renews it."
        action={
          <Link to="/network/domains/new" className="text-primary inline-flex min-h-11 items-center text-sm font-semibold hover:underline">
            Add a domain
          </Link>
        }
      />
    );
  }
  return (
    <RowList label="Domains">
      {domains.map((d) => {
        const s = domainSay(d);
        const v = d.serving && !d.status?.gated ? visitsOf(d) : null;
        return (
          <CalmRow
            key={d.id}
            tone={s.tone}
            name={<span className="font-mono text-[13.5px]">{d.host}</span>}
            sub={`→ ${d.stack} / ${d.serviceName}${d.pathPrefix ? ` ${d.pathPrefix}` : ''}`}
            say={s.say}
            tech={`:${d.targetPort} · tls ${d.tls}${d.auto ? ` · ${autoAddressLabel(d.host)}` : ''}`}
            word={s.word}
            trailing={
              v ? (
                <span className="text-muted-foreground shrink-0 font-mono text-[12px]" title={`visits a minute, last ${v.windowMinutes} min at the edge`}>
                  {perMinText(v.perMin)}/min
                </span>
              ) : null
            }
            to="/network/domains/$host"
            params={{ host: d.host }}
          />
        );
      })}
    </RowList>
  );
}
