import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftIcon, BugIcon, CheckIcon, EyeOffIcon, FilmIcon, GitCommitIcon, ListTreeIcon, RotateCcwIcon, RocketIcon } from 'lucide-react';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, EmptyState, Skeleton, StatusBadge, cn, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { compact, levelTone, shortRelease, statusLabel, timeAgo, type IssueStatus } from './errors-shared';
import { TrendBars } from './issues-list';
import { StackTrace } from './stack-trace';

interface IssueDetailProps {
  stack: string;
  fingerprint: string;
}

/**
 * One issue: what broke (title, where, how often, how many people), what to
 * do about it (resolve / resolve in next release / ignore / reopen), and
 * everything linked to it — the stack trace with source-mapped frames, the
 * trace it happened in, the replay (when recorded), and the release that
 * introduced it.
 */
export function IssueDetail({ stack, fingerprint }: IssueDetailProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [eventId, setEventId] = React.useState<string | undefined>(undefined);
  const detail = useQuery(trpc.errors.issue.queryOptions({ stack, fingerprint, eventId }));
  const d = detail.data;
  const setStatus = useMutation(
    trpc.errors.setIssueStatus.mutationOptions({
      onSuccess: (_r, v) => {
        toast.success(
          v.status === 'resolved'
            ? 'Resolved — it reopens if it happens again'
            : v.status === 'resolved_next_release'
              ? 'Resolves with the next release — errors from a newer release reopen it'
              : v.status === 'ignored'
                ? 'Ignored — no more alerts for this one'
                : 'Reopened',
        );
        void qc.invalidateQueries({ queryKey: trpc.errors.issue.queryKey({ stack, fingerprint }) });
        void qc.invalidateQueries({ queryKey: trpc.errors.issues.queryKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const back = (
    <Link to="/stacks/$name/errors" params={{ name: stack }} className="text-muted-foreground hover:text-foreground mb-3 inline-flex items-center gap-1 text-sm">
      <ArrowLeftIcon className="size-3.5" /> All issues
    </Link>
  );

  if (detail.isLoading) {
    return (
      <div className="space-y-3 pb-8">
        {back}
        <Skeleton className="h-28 w-full rounded-2xl" />
        <Skeleton className="h-96 w-full rounded-2xl" />
      </div>
    );
  }
  if (!d?.issue) {
    return (
      <div className="pb-8">
        {back}
        <EmptyState icon={<BugIcon />} title={d?.status === 'disabled' ? 'The observability store is off' : 'Issue not found'} description="It may have aged out of retention." />
      </div>
    );
  }

  const issue = d.issue;
  const ev = d.event;
  const act = (status: IssueStatus) => setStatus.mutate({ stack, fingerprint, status });
  const open = issue.status === 'unresolved';

  return (
    <div className="pb-8">
      {back}
      <Card className="card-pop mb-4 border-0 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone={levelTone(issue.level)} label={issue.level} />
              <Badge variant={open ? 'warning' : 'muted'}>{statusLabel(issue.status)}</Badge>
              {issue.regressedAt && open ? <Badge variant="destructive">came back {timeAgo(issue.regressedAt)}</Badge> : null}
            </div>
            <h2 className="text-lg font-semibold break-words">{issue.title}</h2>
            <p className="text-muted-foreground mono-data text-xs break-all">{issue.culprit}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {open ? (
              <>
                <Button size="sm" onClick={() => act('resolved')} disabled={setStatus.isPending}>
                  <CheckIcon className="size-3.5" /> Resolve
                </Button>
                <Button size="sm" variant="outline" onClick={() => act('resolved_next_release')} disabled={setStatus.isPending}>
                  <RocketIcon className="size-3.5" /> Resolve in next release
                </Button>
                <Button size="sm" variant="ghost" onClick={() => act('ignored')} disabled={setStatus.isPending}>
                  <EyeOffIcon className="size-3.5" /> Ignore
                </Button>
              </>
            ) : (
              <Button size="sm" variant="outline" onClick={() => act('unresolved')} disabled={setStatus.isPending}>
                <RotateCcwIcon className="size-3.5" /> Reopen
              </Button>
            )}
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-5">
          <Stat label="Events">{compact(issue.count)}</Stat>
          <Stat label="Users">{compact(issue.users)}</Stat>
          <Stat label="First seen">{timeAgo(issue.firstSeen)}</Stat>
          <Stat label="Last seen">{timeAgo(issue.lastSeen)}</Stat>
          <Stat label="Last 24h">
            <TrendBars data={issue.trend.length ? issue.trend : new Array(24).fill(0)} className="mt-1 h-5 w-24" />
          </Stat>
        </div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-4">
          <Card className="card-pop border-0">
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
                <span>Stack trace</span>
                {ev ? (
                  <span className="text-muted-foreground mono-label font-normal">
                    event {ev.eventId.slice(0, 8)} · {timeAgo(ev.timestamp)}
                  </span>
                ) : null}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {ev?.exceptions.length ? (
                <StackTrace exceptions={ev.exceptions} />
              ) : (
                <p className="text-muted-foreground text-sm break-words">{ev?.message || 'No exception data on this event.'}</p>
              )}
            </CardContent>
          </Card>

          <Card className="card-pop border-0">
            <CardHeader>
              <CardTitle className="text-base">Breadcrumbs</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {ev?.breadcrumbs.length ? (
                <div className="border-t">
                  {[...ev.breadcrumbs].reverse().map((b, i) => (
                    <div key={i} className="grid grid-cols-[5.5rem_7rem_minmax(0,1fr)] gap-3 border-b px-6 py-2 text-xs last:border-b-0">
                      <span className="text-muted-foreground mono-data">{b.timestamp ? new Date(b.timestamp).toLocaleTimeString() : '—'}</span>
                      <span className={cn('mono-label truncate', b.level === 'error' && 'text-status-offline', b.level === 'warning' && 'text-status-warning')}>
                        {b.category || b.type}
                      </span>
                      <span className="min-w-0 break-words">
                        {b.message || (b.data ? <code className="mono-data">{JSON.stringify(b.data).slice(0, 240)}</code> : '—')}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-muted-foreground px-6 pb-6 text-sm">No breadcrumbs on this event.</p>
              )}
            </CardContent>
          </Card>

          <Card className="card-pop border-0">
            <CardHeader>
              <CardTitle className="text-base">Recent events</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="border-t">
                {d.events.map((e) => (
                  <button
                    key={e.eventId}
                    type="button"
                    onClick={() => setEventId(e.eventId)}
                    className={cn(
                      'hover:bg-accent/60 grid w-full grid-cols-[6rem_minmax(0,1fr)_auto] items-center gap-3 border-b px-6 py-2 text-left text-xs last:border-b-0',
                      ev?.eventId === e.eventId && 'bg-accent/40',
                    )}
                  >
                    <span className="text-muted-foreground">{timeAgo(e.timestamp)}</span>
                    <span className="truncate">
                      {e.user || 'anonymous'} · {e.serverName || e.environment}
                    </span>
                    <span className="mono-data">{shortRelease(e.release)}</span>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card className="card-pop border-0">
            <CardHeader>
              <CardTitle className="text-base">Linked</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <LinkedRow icon={<ListTreeIcon className="size-4" />} label="Trace">
                {ev?.traceId ? (
                  <Link to="/observability/$traceId" params={{ traceId: ev.traceId }} className="mono-data text-xs underline underline-offset-2">
                    {ev.traceId.slice(0, 16)}…
                  </Link>
                ) : (
                  <span className="text-muted-foreground text-xs">no trace context</span>
                )}
              </LinkedRow>
              <LinkedRow icon={<FilmIcon className="size-4" />} label="Replay">
                {ev?.replayId ? (
                  <a href={`/stacks/${encodeURIComponent(stack)}/replays/${encodeURIComponent(ev.replayId)}`} className="mono-data text-xs underline underline-offset-2">
                    {ev.replayId.slice(0, 12)}…
                  </a>
                ) : (
                  <span className="text-muted-foreground text-xs">not recorded</span>
                )}
              </LinkedRow>
              <LinkedRow icon={<GitCommitIcon className="size-4" />} label="Introduced in">
                {d.introducedIn ? (
                  <span className="text-xs">
                    <span className="mono-data">{shortRelease(d.introducedIn.version)}</span>
                    {d.introducedIn.deployedAt ? (
                      <>
                        {' '}
                        · deployed {timeAgo(d.introducedIn.deployedAt)} ·{' '}
                        <Link to="/stacks/$name/releases" params={{ name: stack }} className="underline underline-offset-2">
                          release history
                        </Link>
                      </>
                    ) : null}
                  </span>
                ) : (
                  <span className="text-muted-foreground text-xs">no release (set SENTRY_RELEASE)</span>
                )}
              </LinkedRow>
              {issue.resolvedInRelease ? (
                <LinkedRow icon={<RocketIcon className="size-4" />} label="Fix expected after">
                  <span className="mono-data text-xs">{shortRelease(issue.resolvedInRelease)}</span>
                </LinkedRow>
              ) : null}
            </CardContent>
          </Card>

          <Card className="card-pop border-0">
            <CardHeader>
              <CardTitle className="text-base">Tags</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {d.tags.length ? (
                d.tags.map((t) => {
                  const total = t.values.reduce((a, v) => a + v.count, 0) || 1;
                  return (
                    <div key={t.key} className="space-y-1">
                      <p className="mono-label text-muted-foreground">{t.key}</p>
                      {t.values.map((v) => (
                        <div key={v.value} className="relative overflow-hidden rounded-md px-2 py-0.5 text-xs">
                          <div className="bg-status-progress/15 absolute inset-y-0 left-0" style={{ width: `${Math.round((v.count / total) * 100)}%` }} />
                          <span className="relative flex justify-between gap-2">
                            <span className="truncate">{v.value}</span>
                            <span className="mono-data">{Math.round((v.count / total) * 100)}%</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  );
                })
              ) : (
                <p className="text-muted-foreground text-sm">No tags.</p>
              )}
            </CardContent>
          </Card>

          {ev ? (
            <Card className="card-pop border-0">
              <CardHeader>
                <CardTitle className="text-base">Event</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-xs">
                {Object.entries(ev.userDetail).map(([k, v]) => (
                  <KV key={k} k={`user.${k}`} v={v} />
                ))}
                {ev.request?.url ? <KV k="request" v={`${ev.request.method ?? ''} ${ev.request.url}`} /> : null}
                <KV k="environment" v={ev.environment} />
                <KV k="release" v={ev.release || '—'} />
                <KV k="sdk" v={ev.sdk || '—'} />
                {ev.grouping ? <KV k="grouped by" v={ev.grouping.variant.replace(/-/g, ' ')} /> : null}
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div>
      <p className="mono-label text-muted-foreground">{label}</p>
      <div className="text-base font-semibold">{children}</div>
    </div>
  );
}

function LinkedRow({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <span className="text-muted-foreground mt-0.5">{icon}</span>
      <div className="min-w-0">
        <p className="mono-label text-muted-foreground">{label}</p>
        {children}
      </div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }): React.JSX.Element {
  return (
    <p className="flex justify-between gap-3">
      <span className="text-muted-foreground mono-label">{k}</span>
      <span className="mono-data min-w-0 truncate text-right" title={v}>
        {v}
      </span>
    </p>
  );
}
