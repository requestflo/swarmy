import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { CalmRow, RowList } from '@/components/calm';
import { EmptyState } from '@/components/states';
import { GlobeIcon } from 'lucide-react';
import { domainSay, type HubDomain } from './use-network';

/** One flat row per address: where it goes, whether HTTPS is on, the tech line at Controls. */
export function DomainList({ domains }: { domains: HubDomain[] }): React.JSX.Element {
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
        return (
          <CalmRow
            key={d.id}
            tone={s.tone}
            name={<span className="font-mono text-[13.5px]">{d.host}</span>}
            sub={`→ ${d.stack} / ${d.serviceName}${d.pathPrefix ? ` ${d.pathPrefix}` : ''}`}
            say={s.say}
            tech={`:${d.targetPort} · tls ${d.tls}${d.auto ? ' · sslip.io' : ''}`}
            word={s.word}
            to="/network/domains/$host"
            params={{ host: d.host }}
          />
        );
      })}
    </RowList>
  );
}
