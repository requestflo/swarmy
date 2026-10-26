import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { BugIcon, ListTreeIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import { clock } from './rum-shared';
import type { RowTone, TimelineRow } from './replay-timeline';
import type { RequestIdLink } from './replay-request-id-model';
import { ReplayRequestId } from './replay-request-id';

const TONE: Record<RowTone, string> = {
  online: 'text-tone-ok',
  offline: 'text-tone-bad',
  warning: 'text-tone-warn',
  progress: 'text-status-progress',
  neutral: 'text-muted-foreground',
};

interface ReplayEventRowProps {
  stack: string;
  row: TimelineRow;
  state: 'now' | 'past' | 'future';
  onSeek: (t: number) => void;
  /** For a failed request with an id: where "Find in logs" goes (null = no link). */
  requestLink?: RequestIdLink | null;
}

/** One side-panel row: click to seek; the trailing icon opens the trace or issue; a failed request names its id. */
export function ReplayEventRow({
  stack,
  row,
  state,
  onSeek,
  requestLink,
}: ReplayEventRowProps): React.JSX.Element {
  return (
    <li
      className={cn(
        'group flex flex-col rounded-lg border border-transparent text-xs transition-colors',
        state === 'now' ? 'border-primary/50 bg-primary/10' : 'hover:bg-accent',
        state === 'future' && 'text-muted-foreground',
      )}
    >
      <div className="flex min-w-0 items-center">
        <button
          type="button"
          onClick={() => onSeek(row.t)}
          className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left"
        >
          <span className="text-muted-foreground w-9 shrink-0 font-mono text-[10.5px]">
            {clock(row.t)}
          </span>
          <span className={cn('w-12 shrink-0 font-mono text-[11px] font-semibold', TONE[row.tone])}>
            {row.badge}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" title={row.main}>
            {row.main}
          </span>
          <span
            className="text-muted-foreground max-w-[40%] shrink-0 truncate font-mono text-[10.5px]"
            title={row.meta}
          >
            {row.meta}
          </span>
        </button>
        {row.fingerprint ? (
          <Link
            to="/stacks/$name/errors/$fingerprint"
            params={{ name: stack, fingerprint: row.fingerprint }}
            aria-label="Open issue"
            title="Open issue"
            className="text-muted-foreground hover:text-foreground px-2"
          >
            <BugIcon className="size-3.5" />
          </Link>
        ) : row.traceId ? (
          <Link
            to="/observability/$traceId"
            params={{ traceId: row.traceId }}
            aria-label="Open trace"
            title="Open trace"
            className="text-muted-foreground hover:text-foreground px-2"
          >
            <ListTreeIcon className="size-3.5" />
          </Link>
        ) : null}
      </div>
      {row.requestId ? (
        <ReplayRequestId stack={stack} id={row.requestId} link={requestLink ?? null} />
      ) : null}
    </li>
  );
}
