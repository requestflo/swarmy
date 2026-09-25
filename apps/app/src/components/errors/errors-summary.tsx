import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, toast } from '@swarmy/ui';
import { CalmRow, NextAction, RowList, Say, Section, type Tone } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { compact, shortRelease, timeAgo } from './errors-shared';

export interface IssueLite {
  fingerprint: string;
  title: string;
  culprit: string | null;
  level: string;
  count: number;
  users: number;
  firstSeen: string | null;
  lastSeen: string | null;
  firstRelease: string | null;
  lastRelease: string | null;
  regressedAt: string | null;
  status: string;
}

const DAY = 24 * 3_600_000;
const isNew = (i: IssueLite): boolean => !!i.firstSeen && Date.now() - Date.parse(i.firstSeen) < DAY;

/** "12 open errors. 3 are new today." — from the unresolved issues list. */
export function errorsHeadline(stack: string, issues: IssueLite[]): { title: React.ReactNode; lede: string } {
  if (issues.length === 0) {
    return { title: <>No open errors in {stack}. <em>Sentry SDKs report here, grouped.</em></>, lede: 'When the app reports an error it shows up here, grouped by where it happened, with the release that brought it.' };
  }
  const fresh = issues.filter(isNew).length;
  const back = issues.filter((i) => i.regressedAt).length;
  const users = issues.reduce((n, i) => n + i.users, 0);
  const events = issues.reduce((n, i) => n + i.count, 0);
  const clause = fresh ? `${fresh} ${fresh === 1 ? 'is' : 'are'} new today.` : back ? `${back} came back after being fixed.` : null;
  return {
    title: (
      <>
        {issues.length} open {issues.length === 1 ? 'error' : 'errors'} in {stack}. {clause ? <Say tone="warn">{clause}</Say> : <em>Nothing new today.</em>}
      </>
    ),
    lede: `${compact(events)} events reached ${compact(users)} people. The worst is first below.`,
  };
}

/** Which issue matters most: new first, then came back, then most people hit. */
export function worstIssue(issues: IssueLite[]): IssueLite | null {
  return [...issues].sort((a, b) => Number(isNew(b)) - Number(isNew(a)) || Number(!!b.regressedAt) - Number(!!a.regressedAt) || b.users - a.users)[0] ?? null;
}

export function ErrorsNextAction({ stack, enabled, worst }: { stack: string; enabled: boolean; worst: IssueLite | null }): React.JSX.Element | null {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const on = useMutation(trpc.errors.setEnabled.mutationOptions({ onSuccess: () => void qc.invalidateQueries(), onError: (e) => toast.error(e.message) }));
  if (!enabled) {
    return (
      <NextAction title="Turn on error tracking" tone="info" tech="stamps swarmy.errors.enabled=true · SENTRY_DSN / SENTRY_RELEASE / SENTRY_ENVIRONMENT injected on the next deploy"
        actions={<Button disabled={on.isPending} onClick={() => on.mutate({ stack, enabled: true })}>{on.isPending ? 'Turning on…' : 'Turn on'}</Button>}>
        Any Sentry SDK works unchanged. swarmy gives {stack} its own DSN on the next deploy.
      </NextAction>
    );
  }
  if (!worst) return null;
  return (
    <NextAction title={worst.title} tone={isNew(worst) ? 'warn' : 'bad'} since={timeAgo(worst.lastSeen)}
      tech={`${worst.culprit ?? 'unknown culprit'} · first in ${shortRelease(worst.firstRelease)} · level ${worst.level}`}
      actions={<Button asChild><Link to="/stacks/$name/errors/$fingerprint" params={{ name: stack, fingerprint: worst.fingerprint }}>Look at it</Link></Button>}>
      {compact(worst.count)} times for {compact(worst.users)} {worst.users === 1 ? 'person' : 'people'}
      {isNew(worst) ? `, new since ${shortRelease(worst.firstRelease)}` : worst.regressedAt ? ', and it came back after a fix' : ''}.
    </NextAction>
  );
}

function word(i: IssueLite): { w: string; tone: Tone } {
  if (isNew(i)) return { w: 'New', tone: 'warn' };
  if (i.regressedAt) return { w: 'Came back', tone: 'bad' };
  return { w: 'Open', tone: 'idle' };
}

/** Summary rows: the open issues in plain words. */
export function ErrorsSummaryList({ stack, issues }: { stack: string; issues: IssueLite[] }): React.JSX.Element | null {
  if (issues.length === 0) return null;
  return (
    <Section title="Open errors" count={issues.length} flush>
      <RowList label="Open errors">
        {issues.slice(0, 8).map((i) => {
          const w = word(i);
          return (
            <CalmRow key={i.fingerprint} tone={w.tone === 'idle' ? 'bad' : w.tone} name={i.title} sub={i.culprit ?? undefined}
              say={`${compact(i.count)} times for ${compact(i.users)} ${i.users === 1 ? 'person' : 'people'}, last ${timeAgo(i.lastSeen)}.`}
              tech={shortRelease(i.lastRelease ?? i.firstRelease)} word={w.w} wordTone={w.tone}
              to={`/stacks/${stack}/errors/${i.fingerprint}`} />
          );
        })}
      </RowList>
    </Section>
  );
}
