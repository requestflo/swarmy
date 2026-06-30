import * as React from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { CheckIcon, RefreshCwIcon, RouteIcon, SearchCheckIcon, XIcon } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { CountUp } from '@/components/count-up';
import { DnsHealthBadge, dnsHealthFromCheck, type DnsHealth } from '@/components/geo/dns-health-badge';

// NOTE: the trailing underscore on `geo_` un-nests this route from `geo.tsx`.
// `geo.tsx` paints its own page with no <Outlet/>, so a nested `/geo/dns` would
// never mount (the parent renders instead). Un-nesting parents this to `_authed`
// — which does render an <Outlet/> — while keeping the public `/geo/dns` URL.
export const Route = createFileRoute('/_authed/geo_/dns')({
  component: GeoDnsPage,
});

/** One live DNS-view row (mirrors the tRPC `DnsViewRow`). */
interface DnsViewRow {
  host: string;
  region: string;
  target: string;
  ip: string;
  healthy: boolean;
}

function GeoDnsPage(): React.JSX.Element {
  const trpc = useTRPC();
  const view = useQuery({
    ...trpc.geodns.dnsView.queryOptions(),
    refetchInterval: 15_000,
  });

  const rows: DnsViewRow[] = Array.isArray(view.data) ? (view.data as DnsViewRow[]) : [];
  const total = rows.length;
  const healthy = rows.filter((r) => r.healthy).length;

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Geo-DNS · Health"
        title={
          total > 0 ? (
            <>
              <CountUp value={healthy} /> of {total} endpoint{total === 1 ? '' : 's'} <em>healthy</em>.
            </>
          ) : (
            <>
              See where DNS <em>points</em>.
            </>
          )
        }
        description="Every zone endpoint swarmy serves, with the IP it resolves to and whether it actually answers. Run a per-host check to compare what swarmy intends against what the public sees."
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <Button asChild variant="outline">
              <Link to="/geo">Records</Link>
            </Button>
            <Button
              variant="outline"
              disabled={view.isFetching}
              onClick={() => void view.refetch()}
            >
              <RefreshCwIcon className={cn('size-4', view.isFetching && 'animate-spin')} /> Refresh
            </Button>
          </div>
        }
      />

      <Card className="card-pop mt-6 border-0">
        <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
          <CardTitle className="text-base">DNS endpoints</CardTitle>
          {total > 0 && (
            <span className="mono-label">
              <CountUp value={healthy} /> / {total} healthy
            </span>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {total === 0 ? (
            <div className="px-6 pb-8">
              <EmptyState
                icon={<RouteIcon />}
                title="Nothing to resolve yet"
                description="Map a host to a regional ingress on the Records page and it shows up here with its live resolved IP and health."
                action={
                  <Button asChild variant="outline">
                    <Link to="/geo">Add a record</Link>
                  </Button>
                }
              />
            </div>
          ) : (
            <div className="border-t">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Host</TableHead>
                    <TableHead>Region</TableHead>
                    <TableHead className="hidden md:table-cell">Target</TableHead>
                    <TableHead className="hidden sm:table-cell">Resolved IP</TableHead>
                    <TableHead>Health</TableHead>
                    <TableHead className="text-right">Check</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <DnsRow key={`${r.host}:${r.region}:${r.target}`} row={r} />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** A DNS endpoint row with an on-demand `checkDomain` probe revealed beneath it. */
function DnsRow({ row }: { row: DnsViewRow }): React.JSX.Element {
  const trpc = useTRPC();
  const [checked, setChecked] = React.useState(false);
  const check = useQuery({
    ...trpc.geodns.checkDomain.queryOptions({ host: row.host }),
    enabled: checked,
    staleTime: 10_000,
  });

  const probe = check.data;
  const status: DnsHealth = probe ? dnsHealthFromCheck(probe) : row.healthy ? 'healthy' : 'down';
  const mismatch = !!probe && !!probe.expectedIp && !!probe.gotIp && probe.expectedIp !== probe.gotIp;

  return (
    <>
      <TableRow>
        <TableCell className="mono-data font-medium">{row.host}</TableCell>
        <TableCell>
          <Badge variant="muted">{row.region}</Badge>
        </TableCell>
        <TableCell className="mono-data text-muted-foreground hidden max-w-[18rem] truncate md:table-cell">
          {row.target}
        </TableCell>
        <TableCell className="mono-data text-muted-foreground hidden sm:table-cell">{row.ip || '—'}</TableCell>
        <TableCell>
          <DnsHealthBadge status={status} />
        </TableCell>
        <TableCell className="text-right">
          <Button
            variant="ghost"
            size="sm"
            disabled={check.isFetching}
            onClick={() => (checked ? void check.refetch() : setChecked(true))}
          >
            <SearchCheckIcon className="size-4" /> {check.isFetching ? 'Checking…' : checked ? 'Re-check' : 'Check'}
          </Button>
        </TableCell>
      </TableRow>
      {probe && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={6} className="bg-muted/30 py-3">
            <div className="mono-data flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
              <ProbeFlag label="resolves" ok={probe.resolves} />
              <span className="text-muted-foreground">
                expected <span className="text-foreground font-medium">{probe.expectedIp || '—'}</span>
              </span>
              <span className="text-muted-foreground">
                got{' '}
                <span className={cn('font-medium', mismatch ? 'text-status-warning' : 'text-foreground')}>
                  {probe.gotIp || '—'}
                </span>
              </span>
              <ProbeFlag label="reachable" ok={probe.reachable} />
              {mismatch && <StatusBadge tone="warning" label="serving a different IP" />}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/** A ✓/✗ flag for a single boolean probe result. */
function ProbeFlag({ label, ok }: { label: string; ok: boolean }): React.JSX.Element {
  return (
    <span className={cn('inline-flex items-center gap-1.5', ok ? 'text-status-online' : 'text-status-offline')}>
      {ok ? <CheckIcon className="size-3.5" /> : <XIcon className="size-3.5" />}
      {label}
    </span>
  );
}
