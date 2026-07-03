import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { LogRowView, ObservabilityLogsInput } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';

export interface OlderPages {
  rows: LogRowView[];
  loading: boolean;
  canLoadMore: boolean;
  loadMore: () => Promise<void>;
}

/**
 * Accumulates "Load older" pages below the head page via the `ts_nano` keyset
 * cursor, resetting whenever the query `input` (window/filters/stack) changes.
 * Split out of {@link useLogsFeed} to keep that hook under the file-size limit.
 */
export function useLogsOlderPages(
  input: ObservabilityLogsInput,
  headCursor: string | null | undefined,
  cap: number,
  headRowCount: number,
): OlderPages {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [rows, setRows] = React.useState<LogRowView[]>([]);
  const [cursorOverride, setCursorOverride] = React.useState<string | null | undefined>(undefined);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    setRows([]);
    setCursorOverride(undefined);
  }, [input]);

  const cursor = cursorOverride === undefined ? (headCursor ?? null) : cursorOverride;
  const canLoadMore = cursor !== null && headRowCount + rows.length < cap;

  const loadMore = React.useCallback(async (): Promise<void> => {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const page = await qc.fetchQuery(trpc.observability.logs.queryOptions({ ...input, cursor }));
      setRows((prev) => [...prev, ...page.rows]);
      setCursorOverride(page.nextCursor);
    } finally {
      setLoading(false);
    }
  }, [cursor, loading, qc, trpc, input]);

  return { rows, loading, canLoadMore, loadMore };
}
