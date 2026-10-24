import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import type { ResilienceDrillKind, ResilienceDrillProgressView } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';

/**
 * The org's drills as they run (`resilience.drillProgress`: a replay of the
 * runs so far, then every step as it starts and ends; each event is the whole
 * run, so the newest per `runId` wins). Returns the newest run of `kind` that
 * is still going, whoever started it, or null. When a run ends, the drill
 * queries refetch so the card shows the recorded outcome.
 */
export function useDrillProgress(kind: ResilienceDrillKind): ResilienceDrillProgressView | null {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [runs, setRuns] = React.useState<Record<string, ResilienceDrillProgressView>>({});
  useSubscription(
    trpc.resilience.drillProgress.subscriptionOptions(undefined, {
      onData: (v) => {
        setRuns((prev) => ({ ...prev, [v.runId]: v }));
        if (v.status) void qc.invalidateQueries({ queryKey: trpc.resilience.pathKey() });
      },
    }),
  );
  return (
    Object.values(runs)
      .filter((r) => r.kind === kind && r.status == null)
      .sort((a, b) => b.startedAt - a.startedAt)[0] ?? null
  );
}
