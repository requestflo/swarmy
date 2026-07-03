import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { GlobeIcon, PlusIcon } from 'lucide-react';
import { Button, EmptyState } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CountUp } from '@/components/count-up';
import { AddDomainCard } from './add-domain-card';
import { StackDomainRow } from './stack-domain-row';

interface StackDomainsSectionProps {
  stack: string;
}

/** Domains & routes for this stack — the tab's hero. One coral CTA: Add domain. */
export function StackDomainsSection({ stack }: StackDomainsSectionProps): React.JSX.Element {
  const trpc = useTRPC();
  const [addOpen, setAddOpen] = React.useState(false);
  const domains = useQuery({ ...trpc.ingress.listDomains.queryOptions({ stack }), refetchInterval: 5000 });

  const rows = domains.data ?? [];
  const secured = rows.filter((d) => d.tls === 'auto' || d.tls === 'custom').length;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="headline text-xl">
            Domains &amp; <em>routes</em>
          </h2>
          {rows.length > 0 ? (
            <p className="text-muted-foreground mono-label mt-1">
              <CountUp value={secured} /> / {rows.length} secured
            </p>
          ) : null}
        </div>
        <Button onClick={() => setAddOpen((v) => !v)}>
          <PlusIcon className="size-4" /> Add domain
        </Button>
      </div>

      <AddDomainCard stack={stack} open={addOpen} onOpenChange={setAddOpen} />

      {domains.isLoading ? null : rows.length === 0 ? (
        <div className="card-pop p-2">
          <EmptyState
            icon={<GlobeIcon />}
            title="No domains routed yet"
            description="Map a hostname onto one of this stack's services and swarmy starts sending it traffic."
            action={
              <Button variant="outline" onClick={() => setAddOpen(true)}>
                <PlusIcon className="size-4" /> Add domain
              </Button>
            }
          />
        </div>
      ) : (
        <div className="card-pop divide-border divide-y overflow-hidden">
          {rows.map((d) => (
            <StackDomainRow key={d.id} domain={d} />
          ))}
        </div>
      )}
    </section>
  );
}
