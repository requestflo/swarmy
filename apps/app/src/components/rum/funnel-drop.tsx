import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { BugIcon } from 'lucide-react';
import { Tech } from '@/components/calm';
import { compact, pct } from './rum-shared';
import { dropSentence, spikeIssue, type FunnelView } from './funnel-model';
import { agoWords } from '@/components/app-tabs/releases/release-label';
import { useDropIssues } from './use-funnels';

interface FunnelDropProps {
  stack: string;
  view: FunnelView;
}

/**
 * "Biggest drop: checkout → paid, since v1.9.0." The "since" clause appears
 * only when the read found a release after which that step clearly got worse;
 * "See the error" only when an error started spiking after that same release.
 */
export function FunnelDrop({ stack, view }: FunnelDropProps): React.JSX.Element | null {
  const words = dropSentence(view);
  const issues = useDropIssues(stack, Boolean(view.since));
  const issue = issues.data?.status === 'ok' ? spikeIssue(issues.data.issues, view.since?.at ?? null) : null;
  if (!words || !view.biggestDrop) return null;
  const d = view.biggestDrop;
  return (
    <div className="border-border flex flex-col gap-1 border-t pt-3">
      <p className="text-sm">
        <span className="font-semibold">
          {words.drop}
          {words.since ? <span className="text-tone-warn">, since {words.since}</span> : null}.
        </span>{' '}
        <span className="text-muted-foreground">
          {compact(d.lost)} of {compact(view.steps[d.index - 1]?.visitors ?? 0)} stopped there ({pct(d.dropOff)}).
        </span>
      </p>
      {view.since ? (
        <Tech>
          {`converted ${pct(view.since.before)} before, ${pct(view.since.after)} since ${words.since}`}
          {view.since.at ? ` · deployed ${agoWords(view.since.at)}` : ''}
        </Tech>
      ) : null}
      {issue ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2">
          <Link
            to="/stacks/$name/errors/$fingerprint"
            params={{ name: stack, fingerprint: issue.fingerprint }}
            className="text-primary inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold sm:min-h-0"
          >
            <BugIcon className="size-4" aria-hidden /> See the error
          </Link>
          <span className="text-muted-foreground min-w-0 truncate font-mono text-xs">
            {issue.title} · {compact(issue.count24h)} in 24 h
          </span>
        </div>
      ) : null}
    </div>
  );
}
