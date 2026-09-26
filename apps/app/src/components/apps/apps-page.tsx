import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { PlusIcon } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@swarmy/ui';
import { CalmPage, useDepth } from '@/components/calm';
import { PageError, PageSkeleton } from '@/components/states';
import { EstateMapCode } from '@/components/estate-map/estate-map-code';
import { EstateMapView } from '@/components/estate-map/estate-map-view';
import { useTRPC } from '@/integrations/trpc';
import { useEstateSummary } from '@/lib/use-estate-summary';
import { groupRows, poolFor, statusCounts, type StatusFilter } from './app-board-model';
import { AppsCodeView } from './apps-code-view';
import { AppsControls, type Grouping } from './apps-controls';
import { AppsEmpty } from './apps-empty';
import { AppsSay, AppsTopMeta, type EstateCounts } from './apps-header';
import { AppsTable } from './apps-table';
import { AppsViewToggle, useAppsView } from './apps-view-toggle';
import { appsSay } from './estate-say';
import { PlatformCards } from './platform-cards';
import { useAppsBoard } from './use-apps-board';

/**
 * Apps (board 69): the sentence, search + filters + grouping, every app as a
 * table-like row (right now · environments · servers · last deploy · traffic),
 * the inline fix for an app that needs you, and swarmy's own parts. The Map
 * view (the estate map: regions, flows, Right now, Rewind) sits behind the
 * List | Map toggle and carries the same sentence in its Right-now card.
 */
export function AppsPage(): React.JSX.Element {
  const trpc = useTRPC();
  const b = useAppsBoard();
  const estate = useEstateSummary();
  const org = useQuery(trpc.org.currentOrg.queryOptions());
  const [view, setView] = useAppsView();
  const code = useDepth().atLeast('code');
  const [q, setQ] = React.useState('');
  const [status, setStatus] = React.useState<StatusFilter>('all');
  const [group, setGroup] = React.useState<Grouping>('none');

  if (b.error) return <PageError title="Couldn’t read your apps." error={b.error} retry={b.refetch} />;
  if (b.pending || estate.status === 'pending') return <PageSkeleton variant="list" />;

  const production = poolFor(b.rows, 'none');
  const e = estate.data;
  const say = appsSay({
    apps: production.map((r) => r.app),
    alertsFiring: e?.alerts.firing ?? 0,
    incidentsOpen: e?.incidents.open ?? 0,
    nodesOnline: e?.nodes.online ?? 0,
    nodesTotal: e?.nodes.total ?? 0,
  });
  const counts: EstateCounts = {
    apps: production.length,
    parts: production.reduce((n, r) => n + r.app.stat.serviceCount, 0),
    needsYou: production.filter((r) => r.status === 'attn').length,
    servers: b.nodes?.length,
    regions: new Set((b.nodes ?? []).map((n) => n.region).filter(Boolean)).size,
  };
  const empty = b.rows.length === 0;

  return (
    <CalmPage
      crumbs={[{ label: 'Apps' }]}
      meta={<AppsTopMeta c={counts} />}
      actions={
        <>
          <AppsViewToggle view={view} onChange={setView} />
          {empty ? null : (
            <Button asChild variant="outline" size="sm" className="hidden sm:inline-flex pointer-coarse:min-h-11">
              <Link to="/deploy">
                <PlusIcon aria-hidden className="size-3.5" /> Deploy an app
              </Link>
            </Button>
          )}
        </>
      }
      wide
      aside={code ? view === 'map' && !empty ? <EstateMapCode traffic={b.traffic} /> : <AppsCodeView apps={b.apps} /> : undefined}
    >
      {empty ? (
        <AppsEmpty workspace={org.data?.name} />
      ) : (
        <>
          {view === 'list' ? (
            <>
              <AppsSay say={say} c={counts} />
              <AppsControls
                q={q}
                onQ={setQ}
                status={status}
                onStatus={setStatus}
                counts={statusCounts(poolFor(b.rows, group), q)}
                group={group}
                onGroup={setGroup}
              />
              <AppsTable
                groups={groupRows(b.rows, group, q, status)}
                labelled={group === 'env'}
                traffic={b.traffic}
                q={q}
                onClear={() => {
                  setQ('');
                  setStatus('all');
                }}
              />
            </>
          ) : (
            <EstateMapView
              b={b}
              say={say}
              servers={{ online: e?.nodes.online ?? 0, total: e?.nodes.total ?? b.nodes?.length ?? 0 }}
              channels={e?.alerts.channels ?? 0}
            />
          )}
        </>
      )}
      {view === 'list' || empty ? <PlatformCards system={b.platform.flatMap((p) => p.stat.services)} nodes={b.nodes} /> : null}
      {view === 'list' && !empty && group === 'none' ? (
        <p className="text-muted-foreground font-mono text-[11px]">
          Click an app to open its canvas ·{' '}
          <kbd className="bg-surface-2 border-border rounded-md border px-1.5 dark:bg-accent">/</kbd> to search · Map shows where each one runs
        </p>
      ) : null}
    </CalmPage>
  );
}
