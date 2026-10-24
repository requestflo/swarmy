import * as React from 'react';
import { CheckIcon, LoaderCircleIcon, XIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import { Section, TONE_DOT } from '@/components/calm';
import { useNow } from '@/components/deploy/deploy-elapsed';
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

/**
 * Clone → roll out, each with how long it took and what it usually takes
 * (board 27's stage rail). Only stages swarmy timed, plus the ones a running
 * build is still on its way to.
 */
export function BuildStagesRail({ build }: { build: BuildLike }): React.JSX.Element | null {
  // Ticks here, not on the page, so a running stage counts up without re-rendering the log.
  const now = useNow();
  const rows = stageRows(build, now);
  if (rows.length === 0) return null;
  const done = rows.filter((r) => r.state === 'done').length;
  return (
    <Section title="Stages" count={`${done} of ${rows.length} done`}>
      <ol className="grid gap-3" aria-label="Build stages">
        {rows.map((r) => (
          <li key={r.key} className="flex items-start gap-3" aria-current={r.state === 'running' ? 'step' : undefined}>
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
          </li>
        ))}
      </ol>
    </Section>
  );
}
