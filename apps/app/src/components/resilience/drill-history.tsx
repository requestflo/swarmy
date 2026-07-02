import * as React from 'react';
import { CheckCircle2Icon, XCircleIcon } from 'lucide-react';
import type { ResilienceDrillResultView } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { DRILL_TITLES, formatDurationMs, relativeTime } from './format';

function HistoryRow({ run }: { run: ResilienceDrillResultView }): React.JSX.Element {
  const [expanded, setExpanded] = React.useState(false);
  const ok = run.status === 'passed';
  const Icon = ok ? CheckCircle2Icon : XCircleIcon;
  return (
    <li>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="hover:bg-accent/50 flex w-full items-start gap-3 px-5 py-3 text-left"
      >
        <Icon className={cn('mt-0.5 size-4 shrink-0', ok ? 'text-status-online' : 'text-status-offline')} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {DRILL_TITLES[run.kind]}
            {run.target ? <span className="text-muted-foreground"> · {run.target}</span> : null}
          </p>
          <p className="text-muted-foreground mt-0.5 truncate text-xs">{run.error ?? run.summary}</p>
        </div>
        <span className="mono-label text-muted-foreground shrink-0">
          {relativeTime(run.at)} · {formatDurationMs(run.durationMs)}
        </span>
      </button>
      {expanded && run.steps.length > 0 ? (
        <ol className="bg-accent/30 space-y-1 px-5 py-3 pl-12">
          {run.steps.map((s, i) => (
            <li key={i} className="flex items-baseline gap-2 text-xs">
              <span
                className={cn(
                  'mono-label shrink-0',
                  s.status === 'passed' && 'text-status-online',
                  s.status === 'failed' && 'text-status-offline',
                  s.status === 'skipped' && 'text-muted-foreground',
                )}
              >
                {s.status}
              </span>
              <span className="font-medium">{s.name}</span>
              {s.detail ? <span className="text-muted-foreground truncate">— {s.detail}</span> : null}
              {s.durationMs != null ? (
                <span className="mono-label text-muted-foreground ml-auto shrink-0">
                  {formatDurationMs(s.durationMs)}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </li>
  );
}

/** Recent drill outcomes, newest first. Click a row for its step timeline. */
export function DrillHistory({
  history,
  isLoading,
}: {
  history: ResilienceDrillResultView[];
  isLoading: boolean;
}): React.JSX.Element {
  return (
    <div className="card-pop">
      <div className="border-border border-b px-5 py-4">
        <h2 className="text-sm font-bold">Drill history</h2>
        <p className="text-muted-foreground mt-0.5 text-xs">Every run, straight from the audit log.</p>
      </div>
      {isLoading ? (
        <div className="space-y-3 p-5">
          {[0, 1].map((i) => (
            <div key={i} className="shimmer-line h-10 rounded-lg" />
          ))}
        </div>
      ) : history.length === 0 ? (
        <p className="text-muted-foreground px-5 py-6 text-sm">
          No drills yet. Run one above — the first restore test turns a backup into a plan.
        </p>
      ) : (
        <ul className="divide-border divide-y">
          {history.map((run) => (
            <HistoryRow key={`${run.kind}@${run.at}`} run={run} />
          ))}
        </ul>
      )}
    </div>
  );
}
