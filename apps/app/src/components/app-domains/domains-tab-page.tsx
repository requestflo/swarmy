import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { CalmRow, Depth, RowList, Say, SayHeader, Section, Tech } from '@/components/calm';
import { PageSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { AddDomainCard } from '@/components/ingress/add-domain-card';
import { StackDomainRow, type StackDomain } from '@/components/ingress/stack-domain-row';
import { StackDnsStatus } from '@/components/geo/stack-dns-status';
import { DomainsCode } from './domains-code';
import { domainWords, domainsHeadline } from './domain-words';

/**
 * The app's Domains tab (DomainProtect board): every address → service with
 * its HTTPS state and protections in one sentence each, and "Add a domain" as
 * the one action. Controls opens each row's protection editor (the ingress
 * components) and the geo-DNS status; Code is swarmy.yaml `domains:` + REST.
 */
export function DomainsTabPage({ stack, add }: { stack: string; add?: string }): React.JSX.Element {
  const trpc = useTRPC();
  const [adding, setAdding] = React.useState(add !== undefined);
  const q = useQuery({ ...trpc.ingress.listDomains.queryOptions({ stack }), refetchInterval: 5000 });
  if (q.isPending) return <PageSkeleton className="px-0 pt-0 xl:px-0" />;
  const rows = (q.data ?? []) as StackDomain[];
  const h = domainsHeadline(stack, rows);

  return (
    <div className="flex flex-col gap-5 pb-8">
      <SayHeader
        size="md"
        title={
          <>
            {h.lead} {h.trouble ? <Say tone="warn">{h.trouble}</Say> : <em>{h.calm}</em>}
          </>
        }
        lede="Every address goes through swarmy’s front door, which gets and renews the certificate and applies the protections before a request reaches the app."
        actions={
          <Button onClick={() => setAdding((v) => !v)} aria-expanded={adding}>
            <PlusIcon className="size-4" /> Add a domain
          </Button>
        }
      />
      <AddDomainCard stack={stack} open={adding} onOpenChange={setAdding} initialHost={add} />
      <DomainsCode stack={stack} rows={rows} />
      <Depth only="summary">
        {rows.length > 0 ? (
          <Section title="Addresses" count={rows.length} flush>
            <RowList label="Addresses">
              {rows.map((d) => {
                const w = domainWords(d);
                return (
                  <CalmRow key={d.id} tone={w.tone} name={`${d.host}${d.pathPrefix && d.pathPrefix !== '/' ? d.pathPrefix : ''}`} sub={`→ ${d.serviceName.replace(`${stack}_`, '')}:${d.targetPort}`} say={w.say} word={w.word} wordTone={w.tone} />
                );
              })}
            </RowList>
          </Section>
        ) : null}
      </Depth>
      <Depth at="controls">
        {rows.length > 0 ? (
          <Section title="Addresses and protections" count={rows.length} hint="open a row to change its protections" flush>
            <div className="divide-border -mx-5 divide-y">
              {rows.map((d) => (
                <StackDomainRow key={d.id} domain={d} />
              ))}
            </div>
            <Tech>each route lives in the swarmy.ingress.routes label; Caddy on the edge servers renders it</Tech>
          </Section>
        ) : null}
        <StackDnsStatus stack={stack} />
      </Depth>
    </div>
  );
}
