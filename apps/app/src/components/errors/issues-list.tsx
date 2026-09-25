import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { BugIcon, SearchIcon } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, EmptyState, Input, Skeleton, cn } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { TrendBars } from './trend-bars';
import { LEVEL_DOT, compact, levelTone, shortRelease, STATUS_FILTERS, timeAgo, type IssueStatus } from './errors-shared';

interface IssuesListProps {
  stack: string;
}


/**
 * The Issues list for one app: one row per grouped error, newest activity
 * first — count, users affected, first / last seen, the release it last
 * happened in, and the last 24 h as bars.
 */
export function IssuesList({ stack }: IssuesListProps): React.JSX.Element {
  const trpc = useTRPC();
  const [status, setStatus] = React.useState<IssueStatus | 'all'>('unresolved');
  const [query, setQuery] = React.useState('');
  const [debounced, setDebounced] = React.useState('');
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 250);
    return () => clearTimeout(t);
  }, [query]);

  const issues = useQuery({
    ...trpc.errors.issues.queryOptions({ stack, status, query: debounced || undefined, limit: 100 }),
    refetchInterval: 15_000,
  });
  const rows = issues.data?.issues ?? [];
  const state = issues.data?.status;

  return (
    <Card className="calm-card shadow-none">
      <CardHeader className="gap-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <BugIcon className="size-4" /> Issues
        </CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <div className="bg-muted/60 flex flex-wrap gap-1 rounded-full p-1">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => setStatus(f.value)}
                className={cn(
                  'rounded-full px-3 py-1 text-xs font-semibold transition-colors',
                  status === f.value ? 'bg-ink text-ink-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="relative min-w-[12rem] flex-1">
            <SearchIcon className="text-muted-foreground absolute top-1/2 left-3 size-3.5 -translate-y-1/2" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search title or where it happened"
              className="h-8 rounded-full pl-8 text-sm"
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {issues.isLoading ? (
          <div className="space-y-2 px-6 pb-6">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-xl" />
            ))}
          </div>
        ) : state === 'no_project' ? (
          <EmptyState className="mx-6 mb-6" icon={<BugIcon />} title="Error tracking is off" description="Turn it on above to get a DSN for this app." />
        ) : state === 'disabled' ? (
          <EmptyState
            className="mx-6 mb-6"
            icon={<BugIcon />}
            title="The observability store is off"
            description="Errors are stored next to traces and logs. Turn Observability on to start keeping them."
          />
        ) : state === 'unreachable' ? (
          <EmptyState className="mx-6 mb-6" icon={<BugIcon />} title="Store unreachable" description="ClickHouse isn't answering right now. Events keep arriving once it's back." />
        ) : rows.length === 0 ? (
          <EmptyState
            className="mx-6 mb-6"
            icon={<BugIcon />}
            title={status === 'unresolved' && !debounced ? 'No open errors' : 'Nothing matches'}
            description={
              status === 'unresolved' && !debounced
                ? 'When the app reports an error through its Sentry SDK it shows up here, grouped.'
                : 'Try another filter.'
            }
          />
        ) : (
          <>
            <div className="text-muted-foreground hidden grid-cols-[minmax(0,1fr)_3.5rem_4.5rem_4.5rem_5.5rem_5.5rem] gap-x-4 px-6 pb-2 md:grid">
              <span className="mono-label">Error</span>
              <span className="mono-label">24h</span>
              <span className="mono-label text-right">Events</span>
              <span className="mono-label text-right">Users</span>
              <span className="mono-label text-right">Seen</span>
              <span className="mono-label text-right">Release</span>
            </div>
            <div className="border-t">
              {rows.map((i) => (
                <Link
                  key={i.fingerprint}
                  to="/stacks/$name/errors/$fingerprint"
                  params={{ name: stack, fingerprint: i.fingerprint }}
                  className="hover:bg-accent/60 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-b px-6 py-3 transition-colors last:border-b-0 md:grid-cols-[minmax(0,1fr)_3.5rem_4.5rem_4.5rem_5.5rem_5.5rem]"
                >
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 truncate text-sm font-semibold">
                      <span className={cn('size-1.5 shrink-0 rounded-full', LEVEL_DOT[levelTone(i.level)])} />
                      <span className="truncate">{i.title}</span>
                    </p>
                    <p className="text-muted-foreground mono-label truncate">
                      {i.culprit || '—'}
                      {i.regressedAt && i.status === 'unresolved' ? <span className="text-tone-bad"> · came back</span> : null}
                      {i.status !== 'unresolved' ? <span> · {i.status.replace(/_/g, ' ')}</span> : null}
                    </p>
                  </div>
                  <TrendBars data={i.trend} className="hidden md:block" />
                  <span className="mono-data text-right text-sm">{compact(i.count)}</span>
                  <span className="mono-data hidden text-right text-sm md:block">{compact(i.users)}</span>
                  <span className="text-muted-foreground hidden text-right text-xs md:block" title={`first seen ${timeAgo(i.firstSeen)}`}>
                    {timeAgo(i.lastSeen)}
                    <br />
                    <span>new {timeAgo(i.firstSeen)}</span>
                  </span>
                  <span className="mono-data hidden truncate text-right text-xs md:block">{shortRelease(i.lastRelease ?? i.firstRelease)}</span>
                </Link>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
