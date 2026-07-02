import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ExternalLinkIcon } from 'lucide-react';
import type { LogRowView } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { severityDisplay, severityDotClass, severityTextClass } from './logs-shared';

interface LogsRowProps {
  row: LogRowView;
  expanded: boolean;
  onToggle: () => void;
}

/** Trim `2026-07-02 10:41:03.123456789` down to a readable `10:41:03.123`. */
function shortTime(timestamp: string): string {
  const t = timestamp.includes(' ') ? timestamp.split(' ')[1]! : timestamp;
  return t.length > 12 ? t.slice(0, 12) : t;
}

/** One log line: severity dot, time, service, body — expands to attributes. */
export function LogsRow({ row, expanded, onToggle }: LogsRowProps): React.JSX.Element {
  const attrs = Object.entries(row.attributes ?? {});
  return (
    <div className={cn('border-b last:border-b-0', expanded && 'bg-accent/40')}>
      <button
        type="button"
        onClick={onToggle}
        className="hover:bg-accent/60 grid w-full grid-cols-[auto_auto_minmax(0,1fr)] items-baseline gap-x-3 px-6 py-1.5 text-left transition-colors sm:grid-cols-[auto_auto_auto_minmax(0,1fr)]"
      >
        <span className={cn('size-1.5 self-center rounded-full', severityDotClass(row.severity_number))} />
        <span className="mono-data text-muted-foreground text-xs">{shortTime(row.timestamp)}</span>
        <span className="mono-label hidden w-24 truncate sm:block">{row.service_name}</span>
        <span className="mono-data truncate text-xs">
          <span className={cn('mr-2 font-semibold', severityTextClass(row.severity_number))}>
            {severityDisplay(row.severity_text, row.severity_number)}
          </span>
          {row.body}
        </span>
      </button>
      {expanded ? (
        <div className="space-y-2 px-6 pb-3 pl-11">
          <p className="mono-data whitespace-pre-wrap break-words text-xs">{row.body}</p>
          <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
            <AttrLine k="service" v={row.service_name} />
            <AttrLine k="severity" v={`${severityDisplay(row.severity_text, row.severity_number)} (${row.severity_number})`} />
            <AttrLine k="timestamp" v={row.timestamp} />
            {row.span_id ? <AttrLine k="span_id" v={row.span_id} /> : null}
            {attrs.map(([k, v]) => (
              <AttrLine key={k} k={k} v={v} />
            ))}
          </div>
          {row.trace_id ? (
            <Link
              to="/observability/$traceId"
              params={{ traceId: row.trace_id }}
              className="text-primary inline-flex items-center gap-1 text-xs font-bold hover:underline"
            >
              <ExternalLinkIcon className="size-3" /> View trace {row.trace_id.slice(0, 12)}…
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function AttrLine({ k, v }: { k: string; v: string }): React.JSX.Element {
  return (
    <p className="min-w-0 text-xs">
      <span className="mono-label text-muted-foreground mr-2">{k}</span>
      <span className="mono-data break-all">{v}</span>
    </p>
  );
}
