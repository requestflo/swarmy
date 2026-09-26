import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowRightIcon } from 'lucide-react';
import { Skeleton, cn } from '@swarmy/ui';
import { TONE_DOT, TONE_TEXT, Tech } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { formatMs, layoutWaterfall } from './waterfall-layout';

const short = (id: string): string => (id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id);

/**
 * The trace behind a log line, inline under it: spans as bars on one time
 * axis (the failing span crimson, the one that held the request amber), a
 * plain sentence about where the time went, and a link to the full trace.
 */
export function TraceWaterfall({ traceId }: { traceId: string }): React.JSX.Element {
  const trpc = useTRPC();
  const q = useQuery(trpc.observability.traceDetail.queryOptions({ traceId }));
  if (q.isPending) return <Skeleton className="h-40 w-full rounded-lg" />;
  const spans = q.data?.status === 'ok' ? q.data.spans : [];
  if (spans.length === 0) {
    return (
      <p className="text-muted-foreground text-[13px]">
        {q.data?.status === 'not_found' ? 'This trace isn’t in the store (it may have aged out).' : 'Couldn’t read the trace right now.'}
      </p>
    );
  }
  const w = layoutWaterfall(spans);
  const root = w.bars[0]?.span;
  return (
    <div className="border-border bg-background/60 flex min-w-0 flex-col gap-3 rounded-[12px] border p-3 sm:p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-[12px]">
        <span className="text-muted-foreground">trace {short(traceId)}</span>
        {root ? <span className="font-semibold break-all">{root.span_name}</span> : null}
        <span className={TONE_TEXT[w.bars.some((b) => b.tone === 'bad') ? 'bad' : 'ok']}>{formatMs(w.totalMs)}</span>
        <span className="text-muted-foreground ml-auto">{w.bars.length} spans · {w.parts} parts</span>
      </div>
      <div className="hidden grid-cols-[minmax(0,2fr)_minmax(0,3fr)_3.5rem] gap-3 font-mono text-[11px] sm:grid">
        <span />
        <div className="text-muted-foreground flex justify-between">
          {w.ticks.map((t, i) => <span key={i}>{formatMs(t)}</span>)}
        </div>
        <span />
      </div>
      <ol className="flex flex-col gap-1.5" aria-label="Spans">
        {w.bars.map((b) => (
          <li key={b.span.span_id} className="grid grid-cols-1 items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_3.5rem]">
            <span className="flex min-w-0 items-center gap-2 font-mono text-[12px]" style={{ paddingLeft: `${Math.min(b.depth, 5) * 12}px` }}>
              <span className={cn('size-1.5 shrink-0 rounded-full', TONE_DOT[b.tone])} aria-hidden />
              <span className={cn('min-w-0 truncate', b.tone === 'bad' || b.tone === 'warn' ? TONE_TEXT[b.tone] : '')}>
                <span className="text-muted-foreground">{b.span.service_name} · </span>
                {b.span.span_name}
              </span>
              <span className="text-muted-foreground ml-auto shrink-0 sm:hidden">{formatMs(b.span.duration_ms)}</span>
            </span>
            <span className="bg-muted/60 relative h-3.5 rounded-full" aria-hidden>
              <span className={cn('absolute inset-y-0 rounded-full', TONE_DOT[b.tone], b.tone === 'info' && 'opacity-70')} style={{ left: `${b.leftPct}%`, width: `${b.widthPct}%` }} />
            </span>
            <span className={cn('hidden text-right font-mono text-[11.5px] sm:block', b.tone === 'bad' || b.tone === 'warn' ? TONE_TEXT[b.tone] : 'text-muted-foreground')}>{formatMs(b.span.duration_ms)}</span>
          </li>
        ))}
      </ol>
      {w.culprit ? (
        <p className="text-[13.5px]">
          <span className="font-semibold">{Math.round(w.culprit.share * 100)}% of this request was one call:</span> {w.culprit.span.service_name} waiting on{' '}
          <span className="font-mono text-[12.5px] break-all">{w.culprit.span.span_name}</span> for {formatMs(w.culprit.selfMs)}
          {w.culprit.span.status_message ? `, then it ${w.culprit.span.status_message}.` : '.'}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/observability/$traceId" params={{ traceId }} className="text-foreground inline-flex min-h-9 items-center gap-1 text-[13px] font-semibold underline-offset-2 hover:underline pointer-coarse:min-h-11">
          Open trace <ArrowRightIcon className="size-3.5" />
        </Link>
        <Tech>observability.traceDetail · otel_traces · trace_id={traceId}</Tech>
      </div>
    </div>
  );
}
