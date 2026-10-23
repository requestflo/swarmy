import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { PlusIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { Depth, Say, SayHeader } from '@/components/calm';
import { PageSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import type { StackDomain } from '@/components/ingress/stack-domain-row';
import { StackDnsStatus } from '@/components/geo/stack-dns-status';
import { DomainsCode } from './domains-code';
import { domainsHeadline } from './domain-words';
import { DomainsWorkspace } from './domains-workspace';

/**
 * The app's Domains tab (DomainProtect, board 30): every address → service
 * in one sentence each, and the picked address in full — its certificate,
 * how visits reach the service, and its protections as switches. "Add a
 * domain" is the one action. Controls adds the full rule form, removing an
 * address and the geo-DNS status; Code is swarmy.yaml, REST and the Caddy
 * site block.
 */
export function DomainsTabPage({ stack, add, domain }: { stack: string; add?: string; domain?: string }): React.JSX.Element {
  const trpc = useTRPC();
  const navigate = useNavigate();
  // Old links (`?add=`) land on the Add a domain page, with the host prefilled.
  React.useEffect(() => {
    if (add !== undefined) void navigate({ to: '/network/domains/new', search: { app: stack, ...(add ? { host: add } : {}) }, replace: true });
  }, [add, stack, navigate]);
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
          <Button asChild>
            <Link to="/network/domains/new" search={{ app: stack }}>
              <PlusIcon className="size-4" /> Add a domain
            </Link>
          </Button>
        }
      />
      {rows.length > 0 ? <DomainsWorkspace stack={stack} rows={rows} selected={domain} /> : <DomainsCode stack={stack} rows={rows} />}
      <Depth at="controls">
        <StackDnsStatus stack={stack} />
      </Depth>
    </div>
  );
}
