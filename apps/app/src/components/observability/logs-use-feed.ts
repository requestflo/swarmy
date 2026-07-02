import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { LogRowView, ObservabilityLogsPage } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import {
  LOGS_LIVE_POLL_MS,
  LOGS_PAGE_SIZE,
  LOGS_ROW_CAP,
  rangePresetMs,
  type LogFilters,
} from './logs-shared';

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
 * query), and pages older rows via the `ts_nano` keyset cursor, capped at
 * {@link LOGS_ROW_CAP} rows.
 */
export function useLogsFeed(filters: LogFilters, live: boolean, enabled: boolean): LogsFeed {
  const trpc = useTRPC();
  const qc = useQueryClient();

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
      serviceName: filters.serviceName,
      severityMin: filters.severityMin,
      search: filters.search.trim() || undefined,
      limit: LOGS_PAGE_SIZE,
    }),
    [anchor, filters],
  );

  const head = useQuery({ ...trpc.observability.logs.queryOptions(input), enabled });

  // Older pages accumulate below the head page until the cap; reset per window.
  const [older, setOlder] = React.useState<LogRowView[]>([]);
  const [olderCursor, setOlderCursor] = React.useState<string | null | undefined>(undefined);
  const [loadingOlder, setLoadingOlder] = React.useState(false);
  React.useEffect(() => {
    setOlder([]);
    setOlderCursor(undefined);
  }, [input]);

  const headRows = React.useMemo(() => head.data?.rows ?? [], [head.data]);
  const rows = React.useMemo(() => [...headRows, ...older].slice(0, LOGS_ROW_CAP), [headRows, older]);

  const cursor = olderCursor === undefined ? (head.data?.nextCursor ?? null) : olderCursor;
  const canLoadOlder = cursor !== null && rows.length < LOGS_ROW_CAP;

  const loadOlder = React.useCallback(async (): Promise<void> => {
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await qc.fetchQuery(trpc.observability.logs.queryOptions({ ...input, cursor }));
      setOlder((prev) => [...prev, ...page.rows]);
      setOlderCursor(page.nextCursor);
    } finally {
      setLoadingOlder(false);
    }
  }, [cursor, loadingOlder, qc, trpc, input]);

  return { rows, status: head.data?.status, isLoading: head.isLoading, canLoadOlder, loadingOlder, loadOlder };
}
