import * as React from 'react';
import { Link } from '@tanstack/react-router';
import type { LogRowView } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { LEVEL_TEXT } from './logs-shared';
import type { NavAction } from './stream-keys';
import { levelOf, lineTime } from './stream-model';
import { TraceWaterfall } from './trace-waterfall';

const shortTrace = (id: string): string => `${id.slice(0, 4)}…${id.slice(-4)}`;

interface StreamLineProps {
  row: LogRowView;
  lineKey: string;
  active: boolean;
  /** The line Tab lands on (roving tabindex). */
  tabbable: boolean;
  open: boolean;
  dispatch: React.Dispatch<NavAction>;
}

/**
 * One mono line: time · part · level word · message, and the trace link.
 * The line is a real button (Enter / click opens it); open, an error line
 * shows its trace waterfall inline, any other line its attributes.
 */
export const StreamLine = React.memo(function StreamLine({ row, lineKey, active, tabbable, open, dispatch }: StreamLineProps): React.JSX.Element {
  const level = levelOf(row.severity_number);
  const attrs = Object.entries(row.attributes ?? {});
  const detailId = `line-${lineKey.replace(/[^a-z0-9]/gi, '')}`;
  return (
    <li className={cn('border-border/60 border-b last:border-b-0', open && 'bg-accent/30')}>
      <div className={cn('flex items-start gap-2 pr-2', level === 'error' && 'bg-status-offline/[0.07]', active && 'ring-ring/70 ring-2 ring-inset')}>
        <button
          type="button"
          data-line={lineKey}
          tabIndex={tabbable ? 0 : -1}
          aria-expanded={open}
          aria-controls={open ? detailId : undefined}
          onClick={() => dispatch({ kind: 'toggle', key: lineKey })}
          onFocus={() => dispatch({ kind: 'focus', key: lineKey })}
          className="hover:bg-accent/50 grid min-h-8 min-w-0 flex-1 grid-cols-[auto_auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-0.5 px-3 py-1.5 text-left font-mono text-[12.5px] outline-none [font-variant-ligatures:none] pointer-coarse:min-h-11 sm:grid-cols-[auto_6.5rem_3.25rem_minmax(0,1fr)]"
        >
          <span className="text-muted-foreground tabular-nums">{lineTime(row.ts_nano)}</span>
          <span className="truncate">{row.service_name}</span>
          <span className={cn('text-[11px] font-bold uppercase', LEVEL_TEXT[level])}>{level}</span>
          <span className="col-span-full min-w-0 break-words whitespace-pre-wrap sm:col-span-1">{row.body}</span>
        </button>
        {row.trace_id ? (
          <Link
            to="/observability/$traceId"
            params={{ traceId: row.trace_id }}
            tabIndex={-1}
            aria-label={`Open trace ${row.trace_id}`}
            className="text-muted-foreground hover:text-foreground hidden shrink-0 py-1.5 font-mono text-[11.5px] underline-offset-2 hover:underline md:block"
          >
            {shortTrace(row.trace_id)}
          </Link>
        ) : null}
      </div>
      {open ? (
        <div id={detailId} className="flex min-w-0 flex-col gap-3 px-3 pt-1 pb-4 sm:pl-6">
          {row.trace_id ? <TraceWaterfall traceId={row.trace_id} /> : null}
          <dl className="grid gap-x-6 gap-y-1 font-mono text-[11.5px] sm:grid-cols-2">
            {[['part', row.service_name], ['severity', `${row.severity_text || level} (${row.severity_number})`], ['time', `${row.timestamp} UTC`], ...attrs].map(([k, v]) => (
              <div key={k} className="flex min-w-0 gap-2">
                <dt className="text-muted-foreground shrink-0">{k}</dt>
                <dd className="min-w-0 break-all">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </li>
  );
});
