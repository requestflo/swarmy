import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { LogRowView, ObservabilityLogsPage } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import {
  LOGS_LIVE_POLL_MS,
  LOGS_PAGE_SIZE,
  LOGS_ROW_CAP,
  rangePresetMs,
  type LogFilters,
} from './logs-shared';
import { useLogsOlderPages } from './logs-use-older-pages';

export interface LogsFeed {
  rows: LogRowView[];
  status: ObservabilityLogsPage['status'] | undefined;
  isLoading: boolean;
  canLoadOlder: boolean;
  loadingOlder: boolean;
  loadOlder: () => Promise<void>;
}

/**
 * The logs data feed: derives `[from, to]` from the range preset, re-anchors it
 * every 10s while `live` is on (the tick IS the poll — a new window is a new
 * query), and pages older rows via {@link useLogsOlderPages}, capped at
 * {@link LOGS_ROW_CAP} rows. An optional `stack` scopes every page server-side.
 */
export function useLogsFeed(
  filters: LogFilters,
  live: boolean,
  enabled: boolean,
  stack?: string,
): LogsFeed {
  const trpc = useTRPC();

  // Window anchor: frozen while paused, re-anchored on a 10s tick when live.
  const [anchor, setAnchor] = React.useState<number>(() => Date.now());
  React.useEffect(() => {
    setAnchor(Date.now());
    if (!live || !enabled) return;
    const t = setInterval(() => setAnchor(Date.now()), LOGS_LIVE_POLL_MS);
    return () => clearInterval(t);
  }, [live, enabled, filters]);

  const input = React.useMemo(
    () => ({
      from: anchor - rangePresetMs(filters.range),
      to: anchor,
      stack,
      serviceName: filters.serviceName,
      severityMin: filters.severityMin,
      search: filters.search.trim() || undefined,
      limit: LOGS_PAGE_SIZE,
    }),
    [anchor, filters, stack],
  );

  const head = useQuery({ ...trpc.observability.logs.queryOptions(input), enabled });
  const headRows = head.data?.rows ?? [];
  const older = useLogsOlderPages(input, head.data?.nextCursor, LOGS_ROW_CAP, headRows.length);

  const rows = React.useMemo(
    () => [...headRows, ...older.rows].slice(0, LOGS_ROW_CAP),
    [headRows, older.rows],
  );

  return {
    rows,
    status: head.data?.status,
    isLoading: head.isLoading,
    canLoadOlder: older.canLoadMore,
    loadingOlder: older.loading,
    loadOlder: older.loadMore,
  };
}
