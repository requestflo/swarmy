import * as React from 'react';
import { GlobeIcon } from 'lucide-react';
import { EmptyState } from '@/components/states';
import { AddDomainDialog } from './add-domain-dialog';
import { DomainCard } from './domain-card';
import type { EmailOverviewData } from './use-email';

/** Sending domains: each with its DNS records and their live status. */
export function DomainsTab({ overview: o }: { overview: EmailOverviewData }): React.JSX.Element {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground max-w-2xl text-sm">
          Mail is only accepted from verified domains. On swarmy DNS the records are published for you; anywhere else, add
          the records shown — the DKIM record verifies the domain.
        </p>
        <AddDomainDialog />
      </div>
      {o.domains.length === 0 ? (
        <div className="card-pop p-2">
          <EmptyState
            icon={<GlobeIcon />}
            title="No sending domains yet — add one."
            description="Use a domain you own, e.g. example.com or mail.example.com. swarmy makes its DKIM key and tells you exactly what to publish."
          />
        </div>
      ) : (
        o.domains.map((d) => <DomainCard key={d.id} domain={d} />)
      )}
    </div>
  );
}
