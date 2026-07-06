import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { RouteIcon } from 'lucide-react';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, cn } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CountUp } from '@/components/count-up';
import type { DnsViewRow } from './geo-types';
import { DomainCheckPopover } from './domain-check-popover';

const SOURCE_LABELS: Record<string, string> = {
  route: 'route',
  'status-page': 'status page',
  webhook: 'webhook',
  'ai-outlet': 'AI outlet',
  apex: 'apex',
  www: 'www',
};

/** Every hostname swarmy answers for, derived live from ingress — no CRUD. */
export function DerivedRecordsCard(): React.JSX.Element {
  const trpc = useTRPC();
  const view = useQuery({ ...trpc.geodns.dnsView.queryOptions({}), refetchInterval: 10_000 });
  const rows = view.data ?? [];
  const healthy = rows.filter((r) => r.healthyCount > 0).length;

  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="text-base">Derived records</CardTitle>
        <CardDescription>
          Web records are never stored — they derive from your routes, status pages, webhooks and
          outlets. Route a domain and it just resolves.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <div className="px-6 pb-8">
            <EmptyState
              icon={<RouteIcon />}
              title="Nothing to answer yet"
              description="Route a hostname under one of your zones from a stack's Network tab and it appears here, geo-steered."
            />
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-4 px-6 py-4">
              <span className="mono-label">
                <CountUp value={healthy} /> / {rows.length} healthy
              </span>
              <span className="text-muted-foreground mono-label">{rows.length} answered</span>
            </div>
            <div className="divide-border divide-y border-t">
              {rows.map((r) => (
                <DerivedRow key={`${r.zone}-${r.host}-${r.source}`} row={r} />
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function DerivedRow({ row }: { row: DnsViewRow }): React.JSX.Element {
  return (
    <div className="hover:bg-accent/40 flex flex-wrap items-center gap-3 px-6 py-3.5 transition-colors">
      <div className="min-w-0 flex-1">
        <p className="mono-data truncate font-medium">{row.host}</p>
        <p className="text-muted-foreground mono-label truncate">
          {row.zone}
          {row.stack ? ` · ${row.stack}` : ''}
        </p>
      </div>
      <Badge variant="muted" className="hidden sm:inline-flex">
        {SOURCE_LABELS[row.source] ?? row.source}
      </Badge>
      <div className="flex flex-wrap items-center gap-2">
        {row.endpoints.map((e, i) => (
          <span
            key={`${e.region}-${e.ip}-${i}`}
            title={`${e.region} · ${e.ip} · ${e.healthy ? 'healthy' : 'unhealthy'}`}
            className="mono-label text-muted-foreground inline-flex items-center gap-1"
          >
            <span
              className={cn(
                'size-2 rounded-full',
                e.healthy ? 'bg-status-online' : 'bg-status-offline',
              )}
            />
            {e.region}
          </span>
        ))}
      </div>
      <span
        className={cn(
          'mono-label w-20 text-right',
          row.healthyCount > 0 ? 'text-status-online' : 'text-status-offline',
        )}
      >
        {row.healthyCount}/{row.endpoints.length} healthy
      </span>
      <DomainCheckPopover host={row.host} />
    </div>
  );
}
