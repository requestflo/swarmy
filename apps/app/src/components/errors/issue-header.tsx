import * as React from 'react';
import { CheckIcon, EyeOffIcon, RocketIcon, RotateCcwIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { CodeView, Say, SayHeader, Tech } from '@/components/calm';
import { compact, shortRelease, statusLabel, timeAgo, type IssueStatus } from './errors-shared';
import { TrendBars } from './trend-bars';

interface IssueHead {
  fingerprint: string;
  title: string;
  culprit: string | null;
  level: string;
  status: IssueStatus;
  count: number;
  users: number;
  firstSeen: string | null;
  lastSeen: string | null;
  firstRelease: string | null;
  lastRelease: string | null;
  regressedAt: string | null;
  trend: number[];
}

/**
 * One issue's sentence header: what broke, how often, for how many people,
 * and the one action (Resolve). The counts and 24 h bars are the Controls
 * line; the Code depth shows the fingerprint and the source-map upload.
 */
export function IssueHeader({
  stack,
  issue,
  busy,
  act,
}: {
  stack: string;
  issue: IssueHead;
  busy: boolean;
  act: (s: IssueStatus) => void;
}): React.JSX.Element {
  const open = issue.status === 'unresolved';
  const people = `${compact(issue.users)} ${issue.users === 1 ? 'person' : 'people'}`;
  return (
    <div className="flex flex-col gap-4">
      <SayHeader
        size="md"
        eyebrow={issue.culprit ?? issue.level}
        title={
          <>
            <span className="font-mono text-[0.85em] break-words">{issue.title}</span>{' '}
            {open ? (
              <Say tone={issue.regressedAt ? 'bad' : 'warn'}>
                {issue.regressedAt ? `came back ${timeAgo(issue.regressedAt)}.` : `hit ${people}.`}
              </Say>
            ) : (
              <em>{statusLabel(issue.status)}.</em>
            )}
          </>
        }
        lede={`${compact(issue.count)} times for ${people}, first ${timeAgo(issue.firstSeen)} in ${shortRelease(issue.firstRelease)}, last ${timeAgo(issue.lastSeen)}.`}
        actions={
          open ? (
            <>
              <Button onClick={() => act('resolved')} disabled={busy}>
                <CheckIcon className="size-4" /> Resolve
              </Button>
              <Button variant="outline" onClick={() => act('resolved_next_release')} disabled={busy}>
                <RocketIcon className="size-4" /> Resolve in next release
              </Button>
              <Button variant="ghost" onClick={() => act('ignored')} disabled={busy}>
                <EyeOffIcon className="size-4" /> Ignore
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => act('unresolved')} disabled={busy}>
              <RotateCcwIcon className="size-4" /> Reopen
            </Button>
          )
        }
      />
      <Tech>
        <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
          level {issue.level} · {issue.count} events · {issue.users} users · last release {shortRelease(issue.lastRelease)} · 24 h
          <TrendBars data={issue.trend.length ? issue.trend : new Array(24).fill(0)} className="h-4 w-24" />
        </span>
      </Tech>
      <CodeView
        title="This issue as code"
        source="readonly"
        tabs={[
          {
            label: 'CLI',
            code: `# frames show your code once the build's source maps are uploaded\nswarmy sourcemaps upload ./dist --app ${stack} --release ${issue.lastRelease ?? '<release>'}`,
          },
          {
            label: 'issue',
            code: JSON.stringify({ fingerprint: issue.fingerprint, title: issue.title, culprit: issue.culprit, level: issue.level, status: issue.status, firstRelease: issue.firstRelease, lastRelease: issue.lastRelease }, null, 2),
          },
        ]}
      />
    </div>
  );
}
