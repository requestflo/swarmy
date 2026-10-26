import type * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckIcon, LoaderCircleIcon, XIcon } from 'lucide-react';
import type { DbRestoreProgressView } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { formatDurationMs } from '@/components/resilience/format';
import { useTRPC } from '@/integrations/trpc';
import { runTitle, stepDetail, stepTech, stepWords } from './restore-progress-words';

interface PgRestoreProgressProps {
  stack: string;
  cluster: string;
  /** A restore from this page is running: poll fast. */
  active: boolean;
  /** This page already says how its own restore ended. */
  hideDone: boolean;
  /** What to say while the restore runs but no step has been reported yet. */
  fallback: string | null;
}

/**
 * Board 40's "Restoring … base backup ✓ · replaying WAL to …": the steps of
 * the restore of this database in flight (`dbBackups.restoreProgress`), the
 * numbers for the one running now, and how it ended for a minute after.
 */
export function PgRestoreProgress({ stack, cluster, active, hideDone, fallback }: PgRestoreProgressProps): React.JSX.Element | null {
  const trpc = useTRPC();
  const q = useQuery({ ...trpc.dbBackups.restoreProgress.queryOptions({ stack, cluster }), refetchInterval: active ? 2_000 : 15_000 });
  const v = q.data ?? null;
  if (!v || (v.status === 'succeeded' && hideDone)) {
    return fallback && active ? <Running text={fallback} /> : null;
  }
  return (
    <div role="status" className="flex flex-col gap-2">
      <p className={cn('text-[13px] font-semibold', v.status === 'failed' && 'text-tone-bad')}>{runTitle(v)}</p>
      <ol aria-label="Restore steps" className="flex flex-col gap-1.5">
        {v.done.map((d) => (
          <Step key={`${d.stage}-${d.startedAt}`} v={v} stage={d.stage} icon="done" right={formatDurationMs(d.endedAt - d.startedAt)} />
        ))}
        {v.current ? <Step v={v} stage={v.current.stage} icon={v.status === 'failed' ? 'failed' : 'running'} detail={stepDetail(v)} /> : null}
      </ol>
      {v.status === 'failed' && v.error ? <Tech>{v.error}</Tech> : null}
    </div>
  );
}

function Running({ text }: { text: string }): React.JSX.Element {
  return (
    <p role="status" className="text-muted-foreground flex items-center gap-2 text-[13px]">
      <LoaderCircleIcon aria-hidden className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
      {text}
    </p>
  );
}

interface StepProps {
  v: DbRestoreProgressView;
  stage: DbRestoreProgressView['done'][number]['stage'];
  icon: 'done' | 'running' | 'failed';
  detail?: string | null;
  right?: string;
}

function Step({ v, stage, icon, detail, right }: StepProps): React.JSX.Element {
  return (
    <li aria-current={icon === 'running' ? 'step' : undefined} className="flex items-start gap-2.5 text-[13px]">
      <span
        aria-hidden
        className={cn(
          'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full',
          icon === 'done' && 'bg-status-online text-background',
          icon === 'failed' && 'bg-status-offline text-background',
          icon === 'running' && 'text-tone-info',
        )}
      >
        {icon === 'done' ? <CheckIcon className="size-2.5" strokeWidth={3.5} /> : null}
        {icon === 'failed' ? <XIcon className="size-2.5" strokeWidth={3.5} /> : null}
        {icon === 'running' ? <LoaderCircleIcon className="size-3.5 animate-spin motion-reduce:animate-none" /> : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn(icon !== 'done' && 'font-semibold')}>
          {stepWords(stage, v)}
          {detail ? <span className="text-muted-foreground font-normal"> · {detail}</span> : null}
        </span>
        <Tech>{stepTech(stage)}</Tech>
      </span>
      {right ? <span className="text-muted-foreground shrink-0 font-mono text-[11.5px]">{right}</span> : null}
    </li>
  );
}
