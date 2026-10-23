import * as React from 'react';
import type { JobRunView } from '@swarmy/core';
import { Button, cn } from '@swarmy/ui';
import { TONE_TEXT } from '@/components/calm';
import { runDuration } from '@/components/jobs/job-status';
import { hhmm, retriedOk } from './yesterday-model';

const failed = (r: JobRunView): boolean => r.status === 'failed' || r.status === 'timeout';

function runWords(r: JobRunView, all: JobRunView[]): string {
  const took = r.finishedAt ? ` · ${runDuration(r.startedAt, r.finishedAt)}` : '';
  const retry = r.attempt > 1 ? ` (retry ${r.attempt - 1})` : '';
  if (r.status === 'running') return `${hhmm(r.startedAt)} running${retry}`;
  if (!failed(r)) return `${hhmm(r.startedAt)} ok${retry}${took}`;
  return `${hhmm(r.startedAt)} ${r.status === 'timeout' ? 'timed out' : 'failed'}${retriedOk(r, all) ? ', retried ok' : ''}${took}`;
}

/**
 * An hour's runs (or one run) and the output swarmy kept: the failed one
 * first, since that's why anyone clicks. Each run is a chip to switch logs.
 */
export function RunLog({ hour, runs, all, name, onClose }: { hour: number | null; runs: JobRunView[]; all: JobRunView[]; name: string; onClose: () => void }): React.JSX.Element {
  const [id, setId] = React.useState<string | null>(null);
  const shown = runs.find((r) => r.id === id) ?? runs.find(failed) ?? runs.at(-1);
  return (
    <div className="bg-surface-2 dark:bg-accent/40 flex flex-col gap-2 rounded-xl px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[12.5px] font-semibold">
          {name}
          {hour !== null ? ` · ${String(hour).padStart(2, '0')}:00` : ''}
        </span>
        <div className="flex flex-wrap gap-1">
          {runs.map((r) => (
            <button
              key={r.id}
              type="button"
              aria-pressed={r.id === shown?.id}
              onClick={() => setId(r.id)}
              className={cn(
                'min-h-7 rounded-md border px-2 font-mono text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:min-h-11',
                r.id === shown?.id ? 'border-foreground/40 bg-card' : 'border-transparent',
                failed(r) ? TONE_TEXT.bad : 'text-muted-foreground',
              )}
            >
              {runWords(r, all)}
            </button>
          ))}
        </div>
        <Button size="sm" variant="ghost" className="ml-auto h-7 pointer-coarse:min-h-11" onClick={onClose}>
          Close log
        </Button>
      </div>
      <pre tabIndex={0} aria-label="Run output" className="calm-code max-h-56 overflow-auto px-3 py-2 text-[11.5px] leading-relaxed whitespace-pre-wrap">
        {shown?.outputTail || 'This run kept no output.'}
      </pre>
    </div>
  );
}
