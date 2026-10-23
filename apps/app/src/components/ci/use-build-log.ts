import * as React from 'react';
import { useSubscription } from '@trpc/tanstack-react-query';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import type { LogChunk } from './build-log-parse';

/**
 * A build's raw log chunks (epic: git-cicd-registry, PHASE-2).
 *
 * Seeds from the historical `buildLogPage` scrollback, then tails the
 * `buildLogs` subscription (fed by the build's `logChunk`s over the existing log
 * plumbing, keyed by build id) while the build runs. De-dups the seed/live overlap.
 */
export function useBuildLog(buildId: string, live: boolean): { chunks: LogChunk[]; pending: boolean } {
  const trpc = useTRPC();
  const [chunks, setChunks] = React.useState<LogChunk[]>([]);
  const seen = React.useRef<Set<number>>(new Set());

  const append = React.useCallback((incoming: LogChunk[]) => {
    // De-dup outside the state updater: StrictMode runs updaters twice, and a
    // ref mutated inside one would drop every line on the second run.
    const fresh = incoming.filter((l) => {
      // seq is per-stream, so key on (seq, stream).
      const key = l.seq * 2 + (l.stream === 'stderr' ? 1 : 0);
      if (seen.current.has(key)) return false;
      seen.current.add(key);
      return true;
    });
    if (fresh.length) setChunks((prev) => [...prev, ...fresh]);
  }, []);

  const page = useQuery(trpc.cicd.buildLogPage.queryOptions({ buildId }));
  React.useEffect(() => {
    if (page.data?.lines) append(page.data.lines);
  }, [page.data, append]);

  useSubscription(
    trpc.cicd.buildLogs.subscriptionOptions(
      { buildId },
      { enabled: live, onData: (line: LogChunk) => append([line]) },
    ),
  );

  return { chunks, pending: page.isPending };
}
