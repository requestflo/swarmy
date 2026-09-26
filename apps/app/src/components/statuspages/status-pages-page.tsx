import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router';
import { cn } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CodeView, Say } from '@/components/calm';
import { ErrorState, SkeletonBody } from '@/components/states';
import { RowPage, plural } from '@/components/rowpage/row-page';
import { PostUpdateSection } from './post-update-section';
import { StatusComponentsSection } from './status-components-section';
import { StatusDomainSection } from './status-domain-section';
import { StatusPagesEmpty } from './status-pages-empty';
import { StatusPreview } from './status-preview';
import { statusPagesCode } from './status-pages-code';
import { nameList, pageAddress } from './status-copy';
import { useStatusSnapshot } from './use-status-snapshot';

const route = getRouteApi('/_authed/status-pages');

/** Activity › Status pages: what customers see, the address, posting an update — beside a live preview of the public page. */
export function StatusPagesPage(): React.JSX.Element {
  const search = route.useSearch();
  const navigate = useNavigate();
  const trpc = useTRPC();
  const { pages, page, snapshot, isLoading, error, refetch } = useStatusSnapshot(search.page);
  const open = useQuery({ ...trpc.incidents.list.queryOptions({ status: 'open', limit: 20 }), refetchInterval: 10_000 });
  const openRows = open.data ?? [];
  const incidentId = openRows.some((i) => i.id === search.incident) ? search.incident : openRows[0]?.id;

  if (error) return <RowPage title="Status pages."><ErrorState title="Couldn’t load your status pages." error={error} retry={refetch} /></RowPage>;
  if (isLoading || !pages) return <RowPage title="Status pages."><SkeletonBody variant="list" /></RowPage>;
  if (!page) {
    return (
      <RowPage title={<>No status page yet. <em>Visitors can’t see how things are.</em></>} description="A public page with live status, 90-day uptime and your incident updates.">
        <StatusPagesEmpty />
      </RowPage>
    );
  }

  const address = pageAddress(page);
  const hurt = (snapshot?.components ?? []).filter((c) => c.status === 'down' || c.status === 'degraded');
  const worst = hurt.some((c) => c.status === 'down') ? 'down' : 'degraded';
  const title = !page.enabled ? (
    <>{address} is switched off. <em>Visitors get “not found”.</em></>
  ) : hurt.length ? (
    <>
      <Say tone={worst === 'down' ? 'bad' : 'warn'}>{nameList(hurt.map((c) => c.label))} {hurt.length === 1 ? 'shows' : 'show'} {worst}</Say> to visitors.
    </>
  ) : (
    <>{address} says <Say tone="ok">all systems normal</Say>.</>
  );
  const upt = snapshot?.components.map((c) => c.uptimePct).filter((p): p is number => p !== null) ?? [];
  const lede = [
    `${plural(page.components.length, 'part')} on the page`,
    upt.length ? `${Math.min(...upt)}% uptime or better over 90 days` : null,
    openRows.length ? `${plural(openRows.length, 'incident')} open — post updates so visitors know` : 'no incident open',
  ].filter(Boolean).join(' · ') + '.';
  const pick = (id: string): void => void navigate({ to: '/status-pages', search: { ...search, incident: id } });

  return (
    <RowPage
      title={title}
      description={lede}
      actions={
        <a href={page.publicPath} target="_blank" rel="noreferrer" className={cn('inline-flex min-h-11 items-center font-mono text-xs font-semibold hover:underline', page.enabled ? 'text-tone-ok' : 'text-muted-foreground')}>
          {page.enabled ? 'Published' : 'Off'} · {address} ↗
        </a>
      }
    >
      {pages.length > 1 ? (
        <nav aria-label="Status pages" className="flex flex-wrap gap-1">
          {pages.map((p) => (
            <Link key={p.id} to="/status-pages" search={{ ...search, page: p.slug }} aria-current={p.id === page.id ? 'page' : undefined} className={cn('inline-flex h-9 items-center rounded-[10px] px-3 text-[13px] font-semibold pointer-coarse:min-h-11', p.id === page.id ? 'bg-surface-2 dark:bg-accent' : 'text-muted-foreground hover:text-foreground')}>
              {p.title}
            </Link>
          ))}
        </nav>
      ) : null}
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <StatusComponentsSection page={page} snapshot={snapshot} />
          <StatusDomainSection page={page} />
          <PostUpdateSection page={page} open={openRows} incidentId={incidentId} onPick={pick} />
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          <CodeView title="This page as code" tabs={statusPagesCode(page, snapshot, incidentId)} source="readonly" note="Dashboard setting · no REST yet. The public JSON needs no key — it’s what the page itself reads." />
          <StatusPreview page={page} snapshot={snapshot} />
        </div>
      </div>
    </RowPage>
  );
}
