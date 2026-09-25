import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { FilmIcon, GitCommitIcon, ListTreeIcon, RocketIcon } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@swarmy/ui';
import { shortRelease, timeAgo } from './errors-shared';
import type { IssueData, IssueEvent } from './issue-types';

/** The aside of an issue: what it links to, its tags, and the picked event's details. */
export function IssueAside({ stack, d, ev }: { stack: string; d: IssueData; ev: IssueEvent | null | undefined }): React.JSX.Element {
  const issue = d.issue!;
  return (
    <>
    <Card className="calm-card shadow-none">
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

    <Card className="calm-card shadow-none">
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
      <Card className="calm-card shadow-none">
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
    </>
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
