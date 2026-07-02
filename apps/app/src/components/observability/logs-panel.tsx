import * as React from 'react';
import { ScrollTextIcon } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Skeleton,
} from '@swarmy/ui';
import { LogsFilterBar } from './logs-filter-bar';
import { LogsRow } from './logs-row';
import { DEFAULT_LOG_FILTERS, LOGS_ROW_CAP, type LogFilters } from './logs-shared';
import { useLogsFeed } from './logs-use-feed';

interface LogsPanelProps {
  enabled: boolean;
}

/**
 * Structured-logs feed (otel_logs): filter bar, severity-coloured expandable
 * rows capped at {@link LOGS_ROW_CAP}, trace cross-links, 10s live tail.
 */
export function LogsPanel({ enabled }: LogsPanelProps): React.JSX.Element {
  const [filters, setFilters] = React.useState<LogFilters>(DEFAULT_LOG_FILTERS);
  const [live, setLive] = React.useState(true);
  const [expandedKey, setExpandedKey] = React.useState<string | null>(null);
  const feed = useLogsFeed(filters, live, enabled);

  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ScrollTextIcon className="size-4" /> Logs
        </CardTitle>
        <CardDescription>
          Every log line from your telemetry-enabled stacks. Filter by service or severity,
          search the text, and click a line for its context — or jump to the trace behind it.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <LogsFilterBar filters={filters} onChange={setFilters} live={live} onLiveChange={setLive} />
        {!enabled ? (
          <EmptyState
            className="mx-6 mb-6"
            icon={<ScrollTextIcon />}
            title="Observability is off"
            description="Turn it on above and enable telemetry on a stack — its logs stream in here."
          />
        ) : feed.isLoading ? (
          <div className="space-y-1.5 px-6 pb-6">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-6 w-full rounded-md" />
            ))}
          </div>
        ) : feed.status === 'unreachable' ? (
          <EmptyState
            className="mx-6 mb-6"
            icon={<ScrollTextIcon />}
            title="Store unreachable"
            description="ClickHouse isn't answering yet. Give it a moment after first deploy."
          />
        ) : feed.rows.length === 0 ? (
          <EmptyState
            className="mx-6 mb-6"
            icon={<ScrollTextIcon />}
            title="No log lines match"
            description="Widen the time range or clear a filter — or send an enabled stack some traffic."
          />
        ) : (
          <>
            <div className="max-h-[540px] overflow-y-auto border-t">
              {feed.rows.map((row) => {
                const key = `${row.ts_nano}-${row.span_id}-${row.service_name}`;
                return (
                  <LogsRow
                    key={key}
                    row={row}
                    expanded={expandedKey === key}
                    onToggle={() => setExpandedKey((cur) => (cur === key ? null : key))}
                  />
                );
              })}
            </div>
            <div className="text-muted-foreground flex items-center justify-between border-t px-6 py-2.5 text-xs">
              <span className="mono-data">
                {feed.rows.length} line{feed.rows.length === 1 ? '' : 's'}
                {feed.rows.length >= LOGS_ROW_CAP ? ' (capped)' : ''}
              </span>
              {feed.canLoadOlder ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 rounded-full text-xs"
                  disabled={feed.loadingOlder}
                  onClick={() => void feed.loadOlder()}
                >
                  {feed.loadingOlder ? 'Loading…' : 'Load older'}
                </Button>
              ) : null}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
