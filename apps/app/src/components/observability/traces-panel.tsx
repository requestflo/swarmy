import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ActivityIcon, ListTreeIcon } from 'lucide-react';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Skeleton,
  Switch,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

interface TracesPanelProps {
  enabled: boolean;
  /** Scope the list to one stack (`swarmy.stack` resource attribute). */
  stack?: string;
}

/** Jaeger-lite list of last-hour root spans — flat rows in one card-pop. */
export function TracesPanel({ enabled, stack }: TracesPanelProps): React.JSX.Element {
  const trpc = useTRPC();
  const [errorsOnly, setErrorsOnly] = React.useState(false);
  const traces = useQuery({
    ...trpc.observability.traces.queryOptions({ windowMinutes: 60, errorsOnly, limit: 100, stack }),
    enabled,
    refetchInterval: enabled ? 10_000 : false,
  });

  const rows = traces.data?.traces ?? [];

  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-2">
            <ListTreeIcon className="size-4" /> Traces
          </span>
          <label className="text-muted-foreground flex items-center gap-2 text-xs font-normal">
            Errors only
            <Switch checked={errorsOnly} onCheckedChange={setErrorsOnly} />
          </label>
        </CardTitle>
        <CardDescription>Last hour of root spans. A Jaeger-lite list — no embedded Jaeger.</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {!enabled ? (
          <EmptyState
            className="mx-6 mb-6"
            icon={<ActivityIcon />}
            title="Observability is off"
            description="Flip the switch to stand up the collector and start capturing traces."
          />
        ) : traces.isLoading ? (
          <div className="space-y-2 px-6 pb-6">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full rounded-xl" />
            ))}
          </div>
        ) : traces.data?.status === 'unreachable' ? (
          <EmptyState
            className="mx-6 mb-6"
            icon={<ActivityIcon />}
            title="Store unreachable"
            description="The collector is up but ClickHouse isn't answering yet. Give it a moment after first deploy."
          />
        ) : rows.length === 0 ? (
          <EmptyState
            className="mx-6 mb-6"
            icon={<ActivityIcon />}
            title="No traces yet"
            description="Enable telemetry on a stack and send it some traffic — spans will appear here."
          />
        ) : (
          <>
            <div className="text-muted-foreground grid grid-cols-[2fr_1fr_auto_auto] gap-x-4 px-6 pb-2">
              <span className="mono-label">Operation</span>
              <span className="mono-label hidden sm:block">Service</span>
              <span className="mono-label text-right">Spans</span>
              <span className="mono-label text-right">Duration</span>
            </div>
            <div className="border-t">
              {rows.map((t) => (
                <Link
                  key={t.span_id}
                  to="/observability/$traceId"
                  params={{ traceId: t.trace_id }}
                  className="hover:bg-accent/60 grid grid-cols-[2fr_1fr_auto_auto] items-center gap-x-4 border-b px-6 py-3 transition-colors last:border-b-0"
                >
                  <div className="min-w-0">
                    <p className="mono-data flex items-center gap-2 truncate font-medium">
                      {t.status_code !== 'STATUS_CODE_OK' ? (
                        <span className="bg-status-offline size-1.5 shrink-0 rounded-full" />
                      ) : null}
                      {t.span_name}
                    </p>
                    <p className="text-muted-foreground mono-label truncate sm:hidden">{t.service_name}</p>
                  </div>
                  <span className="hidden truncate text-sm sm:block">{t.service_name}</span>
                  <span className="mono-data text-right text-sm">{t.span_count}</span>
                  <span className="text-right">
                    <Badge variant="muted">{t.duration_ms} ms</Badge>
                  </span>
                </Link>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
