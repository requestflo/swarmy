import * as React from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { LogRowView, ObservabilityLogsPage } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { LOGS_LIVE_POLL_MS, LOGS_ROW_CAP, rangePreset, type LogRangePreset } from './logs-shared';
import { splitAtCutoff } from './stream-model';

export interface LogStreamQuery {
  stack: string;
  range: LogRangePreset;
  part?: string;
  search: string;
  enabled: boolean;
  paused: boolean;
}

export interface LogStream {
  /** Newest first, frozen at the pause point while paused. */
  rows: LogRowView[];
  /** Lines that arrived since the pause. */
  fresh: number;
  /** The query hit its row limit: older lines in the window aren't shown. */
  capped: boolean;
  status: ObservabilityLogsPage['status'] | undefined;
  isPending: boolean;
}

/**
 * The live log stream: `observability.logs` over a sliding window that
 * re-anchors every {@link LOGS_LIVE_POLL_MS}. It keeps polling while paused;
 * the view freezes at the newest line seen when you paused and counts what
 * came after, so "N new lines" is a real number.
 */
export function useLogStream(q: LogStreamQuery): LogStream {
  const trpc = useTRPC();
  const [anchor, setAnchor] = React.useState(() => Date.now());
  React.useEffect(() => {
    setAnchor(Date.now());
    if (!q.enabled) return;
    const t = setInterval(() => setAnchor(Date.now()), LOGS_LIVE_POLL_MS);
    return () => clearInterval(t);
  }, [q.enabled, q.range, q.part, q.search]);

  const search = q.search.trim();
  const input = {
    from: anchor - rangePreset(q.range).ms,
    to: anchor,
    stack: q.stack,
    ...(q.part ? { serviceName: q.part } : {}),
    ...(search ? { search } : {}),
    limit: LOGS_ROW_CAP,
  };
  const feed = useQuery({ ...trpc.observability.logs.queryOptions(input), enabled: q.enabled, placeholderData: keepPreviousData });
  const latest = feed.data?.rows;

  const [cutoff, setCutoff] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!q.paused) setCutoff(null);
    else setCutoff((c) => c ?? latest?.[0]?.ts_nano ?? '0');
    // Freeze only on the pause edge; later polls must not move the cutoff.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.paused]);

  const { shown, fresh } = React.useMemo(() => splitAtCutoff(latest ?? [], q.paused ? cutoff : null), [latest, cutoff, q.paused]);
  return {
    rows: shown,
    fresh,
    capped: (latest?.length ?? 0) >= LOGS_ROW_CAP,
    status: feed.data?.status,
    isPending: feed.isPending,
  };
}
