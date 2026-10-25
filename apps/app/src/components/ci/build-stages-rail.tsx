import * as React from 'react';
import { CheckIcon, LoaderCircleIcon, XIcon } from 'lucide-react';
import { Button, cn } from '@swarmy/ui';
import { Section, TONE_DOT } from '@/components/calm';
import { useNow } from '@/components/deploy/deploy-elapsed';
import { isLogStage, type LogStage } from './build-log-stages';
import { stageRows, type BuildLike, type StageRowView } from './build-stage-model';

function StageIcon({ row }: { row: StageRowView }): React.JSX.Element {
  const icon =
    row.state === 'done' ? (
      <CheckIcon className="size-3 text-background" strokeWidth={3.4} />
    ) : row.state === 'failed' ? (
      <XIcon className="size-3 text-background" strokeWidth={3.4} />
    ) : row.state === 'running' ? (
      <LoaderCircleIcon className="size-3 text-background motion-safe:animate-spin" strokeWidth={3.4} />
    ) : null;
  return (
    <span aria-hidden className={cn('mt-0.5 grid size-[18px] shrink-0 place-items-center rounded-full', TONE_DOT[row.tone])}>
      {icon}
    </span>
  );
}

const STATE_WORD: Record<StageRowView['state'], string> = { done: 'done', running: 'running', failed: 'failed', pending: 'not yet' };

/** Picking a stage narrows the log to its lines (clone, build and push are the builder's; the rest have none). */
export interface StagePick {
  lines: Record<LogStage, number>;
  current: LogStage | null;
  onPick: (stage: LogStage | null) => void;
}

function RowBody({ r }: { r: StageRowView }): React.JSX.Element {
  return (
    <>
      <StageIcon row={r} />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <div className="flex items-baseline gap-2">
          <span className={cn('text-[13.5px] font-semibold', r.state === 'pending' && 'text-muted-foreground')}>{r.label}</span>
          <span className="sr-only">{STATE_WORD[r.state]}</span>
          <span className="text-muted-foreground ml-auto shrink-0 font-mono text-[11px]">{r.time}</span>
        </div>
        {r.detail ? (
          <span className={cn('truncate text-xs', r.state === 'failed' ? 'text-tone-bad' : 'text-muted-foreground')} title={r.detail}>
            {r.detail}
          </span>
        ) : null}
      </div>
    </>
  );
}

/**
 * Clone → roll out, each with how long it took and what it usually takes
 * (board 27's stage rail). Only stages swarmy timed, plus the ones a running
 * build is still on its way to. Clone, build and push filter the log to
 * their own lines; Show all brings the whole log back.
 */
export function BuildStagesRail({ build, pick }: { build: BuildLike; pick?: StagePick }): React.JSX.Element | null {
  // Ticks here, not on the page, so a running stage counts up without re-rendering the log.
  const now = useNow();
  const rows = stageRows(build, now);
  if (rows.length === 0) return null;
  const done = rows.filter((r) => r.state === 'done').length;
  const showAll = pick?.current ? (
    <Button variant="ghost" size="sm" className="pointer-coarse:min-h-11" onClick={() => pick.onPick(null)}>
      Show all
    </Button>
  ) : undefined;
  return (
    <Section title="Stages" count={`${done} of ${rows.length} done`} action={showAll}>
      <ol className="grid gap-1" aria-label="Build stages">
        {rows.map((r) => {
          const lines = pick && isLogStage(r.key) ? pick.lines[r.key] : 0;
          const on = pick?.current === r.key;
          return (
            <li key={r.key} aria-current={r.state === 'running' ? 'step' : undefined}>
              {pick && isLogStage(r.key) && lines > 0 ? (
                <button
                  type="button"
                  aria-pressed={on}
                  title={on ? 'Showing only this stage’s log' : `Show only ${r.label.toLowerCase()} in the log (${lines} line${lines === 1 ? '' : 's'})`}
                  className={cn('flex w-full items-start gap-3 rounded-md px-1.5 py-1.5 text-left hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-ring/50 outline-none', on && 'bg-accent')}
                  onClick={() => pick.onPick(on ? null : (r.key as LogStage))}
                >
                  <RowBody r={r} />
                </button>
              ) : (
                <div className="flex items-start gap-3 px-1.5 py-1.5">
                  <RowBody r={r} />
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </Section>
  );
}
