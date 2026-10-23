import * as React from 'react';
import type { JobRunView } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { Section, Tech } from '@/components/calm';
import { RowsSkeleton } from '../tab-body';
import { RunLog } from './run-log';
import { dayWords, type Lane } from './yesterday-model';

const AXIS = ['00', '06', '12', '18', '24'];

function cellClass(runs: number, failed: number): string {
  if (runs === 0) return 'bg-muted/40';
  if (failed > 0) return 'bg-status-offline';
  return runs >= 3 ? 'bg-status-online' : runs === 2 ? 'bg-status-online/70' : 'bg-status-online/45';
}

/**
 * "Yesterday, hour by hour" (board AppJobs): one lane per job, an hour per
 * cell — green ran clean, crimson had a failure — and a click opens that
 * hour's runs and a log. Picking a lane picks the job below.
 */
export function YesterdaySection({ lanes, runs, picked, onPick }: { lanes: Lane[] | undefined; runs: Map<string, JobRunView[]> | undefined; picked: string | undefined; onPick: (id: string) => void }): React.JSX.Element {
  const [at, setAt] = React.useState<{ jobId: string; hour: number } | null>(null);
  const cell = at ? lanes?.find((l) => l.job.id === at.jobId)?.cells[at.hour] : undefined;
  return (
    <Section title="Yesterday, hour by hour" hint="UTC · click an hour" action={lanes && runs ? <span className="text-muted-foreground font-mono text-[11.5px]">{dayWords(lanes, runs)}</span> : undefined}>
      {!lanes || !runs ? (
        <RowsSkeleton rows={2} />
      ) : (
        <>
          <div className="grid grid-cols-[minmax(4rem,5.5rem)_repeat(24,minmax(0,1fr))] items-center gap-x-[2px] gap-y-1.5 sm:grid-cols-[minmax(4.5rem,9rem)_repeat(24,minmax(0,1fr))] sm:gap-x-[3px]">
            {lanes.map((l) => (
              <React.Fragment key={l.job.id}>
                <button
                  type="button"
                  aria-pressed={l.job.id === picked}
                  onClick={() => onPick(l.job.id)}
                  className={cn('min-h-8 truncate rounded-md pr-2 text-left font-mono text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60', l.job.id === picked ? 'text-foreground font-semibold' : 'text-muted-foreground hover:text-foreground')}
                >
                  {l.job.name}
                </button>
                {l.cells.map((c, h) => (
                  <button
                    key={h}
                    type="button"
                    aria-label={`${l.job.name} ${String(h).padStart(2, '0')}:00, ${c.runs.length} run${c.runs.length === 1 ? '' : 's'}${c.failed ? `, ${c.failed} failed` : ''}`}
                    aria-pressed={at?.jobId === l.job.id && at.hour === h}
                    disabled={c.runs.length === 0}
                    onClick={() => {
                      setAt({ jobId: l.job.id, hour: h });
                      onPick(l.job.id);
                    }}
                    className={cn('h-6 rounded-[3px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60 enabled:hover:opacity-80 pointer-coarse:h-8', cellClass(c.runs.length, c.failed), at?.jobId === l.job.id && at.hour === h && 'ring-foreground/70 ring-2')}
                  />
                ))}
              </React.Fragment>
            ))}
            <span />
            <div className="text-muted-foreground col-span-24 flex justify-between font-mono text-[10px]">
              {AXIS.map((a) => (
                <span key={a}>{a}</span>
              ))}
            </div>
          </div>
          {cell && at ? <RunLog hour={at.hour} runs={cell.runs} all={runs.get(at.jobId) ?? []} name={lanes.find((l) => l.job.id === at.jobId)?.job.name ?? ''} onClose={() => setAt(null)} /> : null}
          <Tech>jobs.runs per job · startedAt bucketed by UTC hour · a failed run counts as retried when a later attempt succeeds within the hour</Tech>
        </>
      )}
    </Section>
  );
}
