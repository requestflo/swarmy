import * as React from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeftIcon, ListTreeIcon } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Skeleton,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';

export const Route = createFileRoute('/_authed/observability/$traceId')({
  component: TraceDetailPage,
});

interface SpanRow {
  trace_id: string;
  span_id: string;
  parent_span_id: string;
  service_name: string;
  span_name: string;
  span_kind: string;
  start_unix_nano: string;
  duration_ms: number;
  status_code: string;
  status_message: string;
}

/** A flat waterfall row carrying its depth + relative offset for the gantt. */
interface WaterfallRow {
  span: SpanRow;
  depth: number;
  /** ms from trace start to this span's start. */
  offsetMs: number;
}

/**
 * Lay spans out as a waterfall: order by the parent/child tree (depth-first),
 * compute each span's offset relative to the earliest span start. Pure so the
 * gantt math is trivial to reason about.
 */
function buildWaterfall(spans: SpanRow[]): { rows: WaterfallRow[]; totalMs: number } {
  if (spans.length === 0) return { rows: [], totalMs: 0 };

  const startOf = (s: SpanRow): number => Number(s.start_unix_nano) / 1_000_000;
  const traceStart = Math.min(...spans.map(startOf));
  const traceEnd = Math.max(...spans.map((s) => startOf(s) + s.duration_ms));
  const totalMs = Math.max(traceEnd - traceStart, 0.001);

  const childrenOf = new Map<string, SpanRow[]>();
  const byId = new Map(spans.map((s) => [s.span_id, s]));
  for (const s of spans) {
    const parentKey = byId.has(s.parent_span_id) ? s.parent_span_id : '';
    const list = childrenOf.get(parentKey) ?? [];
    list.push(s);
    childrenOf.set(parentKey, list);
  }
  for (const list of childrenOf.values()) {
    list.sort((a, b) => startOf(a) - startOf(b));
  }

  const rows: WaterfallRow[] = [];
  const walk = (parentKey: string, depth: number): void => {
    for (const span of childrenOf.get(parentKey) ?? []) {
      rows.push({ span, depth, offsetMs: startOf(span) - traceStart });
      walk(span.span_id, depth + 1);
    }
  };
  walk('', 0);

  return { rows, totalMs };
}

function TraceDetailPage(): React.JSX.Element {
  const { traceId } = Route.useParams();
  const trpc = useTRPC();

  const detail = useQuery(trpc.observability.traceDetail.queryOptions({ traceId }));
  const spans = (detail.data?.spans ?? []) as SpanRow[];
  const { rows, totalMs } = React.useMemo(() => buildWaterfall(spans), [spans]);

  const root = rows[0]?.span;
  const status = detail.data?.status;

  return (
    <div className="mx-auto w-full max-w-[1400px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Mission Control · Trace"
        title={
          <>
            Span <em>waterfall</em>.
          </>
        }
        description={root ? `${root.service_name} · ${root.span_name}` : traceId}
        actions={
          <Button asChild variant="ghost">
            <Link to="/observability">
              <ArrowLeftIcon className="size-4" /> Back to traces
            </Link>
          </Button>
        }
      />

      <Card className="card-pop border-0">
        <CardHeader>
          <CardTitle className="flex items-center justify-between text-base">
            <span className="flex items-center gap-2">
              <ListTreeIcon className="size-4" /> {rows.length} span{rows.length === 1 ? '' : 's'}
            </span>
            {totalMs > 0 ? <Badge variant="muted">{totalMs.toFixed(2)} ms total</Badge> : null}
          </CardTitle>
          <CardDescription className="mono-data truncate">{traceId}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {detail.isLoading ? (
            <div className="space-y-2 px-6 pb-6">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-9 w-full rounded-lg" />
              ))}
            </div>
          ) : status === 'disabled' ? (
            <EmptyState
              className="mx-6 mb-6"
              icon={<ListTreeIcon />}
              title="Observability is off"
              description="Enable the suite and this trace's spans will render here."
            />
          ) : status === 'unreachable' ? (
            <EmptyState
              className="mx-6 mb-6"
              icon={<ListTreeIcon />}
              title="Store unreachable"
              description="ClickHouse isn't answering yet."
            />
          ) : status === 'not_found' || rows.length === 0 ? (
            <EmptyState
              className="mx-6 mb-6"
              icon={<ListTreeIcon />}
              title="Trace not found"
              description="This trace has aged out of retention, or never existed for your org."
            />
          ) : (
            <div className="border-t">
              {rows.map(({ span, depth, offsetMs }) => {
                const leftPct = (offsetMs / totalMs) * 100;
                const widthPct = Math.max((span.duration_ms / totalMs) * 100, 0.5);
                const isError = span.status_code !== 'STATUS_CODE_OK';
                return (
                  <div
                    key={span.span_id}
                    className="hover:bg-accent/50 grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-center gap-x-4 border-b px-6 py-2 transition-colors last:border-b-0"
                  >
                    <div className="min-w-0" style={{ paddingLeft: `${depth * 14}px` }}>
                      <p className="mono-data flex items-center gap-2 truncate text-sm font-medium">
                        {isError ? (
                          <span className="bg-status-offline size-1.5 shrink-0 rounded-full" />
                        ) : null}
                        {span.span_name}
                      </p>
                      <p className="text-muted-foreground mono-label truncate">
                        {span.service_name}
                        {span.span_kind ? ` · ${span.span_kind.replace('SPAN_KIND_', '').toLowerCase()}` : ''}
                      </p>
                    </div>
                    <div className="relative h-6">
                      <div className="bg-muted/40 absolute inset-0 rounded" />
                      <div
                        className={`absolute top-0 flex h-6 items-center rounded ${
                          isError ? 'bg-status-offline/70' : 'bg-primary/70'
                        }`}
                        style={{ left: `${leftPct}%`, width: `${widthPct}%`, minWidth: '2px' }}
                        title={`${span.duration_ms} ms`}
                      />
                      <span className="text-muted-foreground absolute right-1 top-0 flex h-6 items-center text-[10px]">
                        {span.duration_ms} ms
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
