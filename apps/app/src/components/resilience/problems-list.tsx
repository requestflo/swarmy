import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowRightIcon, InfoIcon, OctagonAlertIcon, TriangleAlertIcon } from 'lucide-react';
import type { ResilienceProblemView, ResilienceSeverity } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { SEVERITY_TONE } from './format';

const SEVERITY_ICON: Record<ResilienceSeverity, React.ComponentType<{ className?: string }>> = {
  crit: OctagonAlertIcon,
  warn: TriangleAlertIcon,
  info: InfoIcon,
};

function ProblemRow({ problem }: { problem: ResilienceProblemView }): React.JSX.Element {
  const tone = SEVERITY_TONE[problem.severity];
  const Icon = SEVERITY_ICON[problem.severity];
  return (
    <li className="flex items-start gap-4 px-5 py-4">
      <span className={cn('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full', tone.bg)}>
        <Icon className={cn('size-4', tone.text)} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-bold">{problem.title}</p>
          <span className={cn('mono-label rounded-full px-2 py-0.5', tone.bg, tone.text)}>
            {tone.label}
          </span>
        </div>
        <p className="text-muted-foreground mt-1 text-xs">{problem.detail}</p>
        <p className="text-muted-foreground mt-1 text-xs">{problem.fixHint}</p>
      </div>
      <Link
        to={problem.fixPath}
        className="text-primary mt-1 flex shrink-0 items-center gap-1 text-xs font-bold hover:underline"
      >
        {problem.fixLabel} <ArrowRightIcon className="size-3.5" />
      </Link>
    </li>
  );
}

/** The problems feed: flat rows in one card, severity-sorted by the server. */
export function ProblemsList({
  problems,
}: {
  problems: ResilienceProblemView[];
}): React.JSX.Element {
  if (problems.length === 0) {
    return (
      <div className="card-pop p-8 text-center">
        <p className="headline text-2xl">
          Everything's <em>covered</em>.
        </p>
        <p className="text-muted-foreground mt-2 text-sm">
          Replicas, backups, topology and the edge all check out. Run a drill below to keep it proven.
        </p>
      </div>
    );
  }
  return (
    <div className="card-pop">
      <div className="border-border border-b px-5 py-4">
        <h2 className="text-sm font-bold">
          {problems.length} thing{problems.length === 1 ? '' : 's'} weakening your score
        </h2>
        <p className="text-muted-foreground mt-0.5 text-xs">
          Fix these and the score climbs back toward 100.
        </p>
      </div>
      <ul className="divide-border divide-y">
        {problems.map((p) => (
          <ProblemRow key={p.id} problem={p} />
        ))}
      </ul>
    </div>
  );
}
