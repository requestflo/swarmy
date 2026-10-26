import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NodeSummary } from '@swarmy/core';
import { toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { copyNameOf, planCopy, type PgSwitchoverFacts } from './pg-switchover-plan';
import { shortName } from './pg-topology';

type Cluster = PgSwitchoverFacts['cluster'] & { primary: { status: string } };

/**
 * A planned switchover of one Postgres database: its run (`db.switchoverRun`,
 * fast while it runs), the reads the shared plan needs (`db.replication`,
 * `db.pooler` — only when `read`, since every replication read is an audited
 * studio query) and `db.switchover` itself.
 */
export function usePgSwitchover(stack: string, c: Cluster | null, place: Map<string, NodeSummary[]> | undefined, read: boolean) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const cluster = c?.name ?? '';
  const run = useQuery({
    ...trpc.db.switchoverRun.queryOptions({ stack, cluster }),
    enabled: !!c,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 1_500 : 15_000),
  });
  const ask = !!c && read;
  const repl = useQuery({
    ...trpc.db.replication.queryOptions({ stack, cluster }),
    enabled: ask && c.primary.status === 'running',
    refetchInterval: 15_000,
    retry: false,
  });
  const pooler = useQuery({ ...trpc.db.pooler.queryOptions({ stack, cluster }), enabled: ask, retry: false });
  const start = useMutation(
    trpc.db.switchover.mutationOptions({
      onSuccess: () => void qc.invalidateQueries(),
      onError: (e) => toast.error(e.message),
    }),
  );
  const view = run.data ?? null;
  // A run that just ended changed the roles: read everything again.
  const was = React.useRef<string | undefined>(undefined);
  React.useEffect(() => {
    if (was.current === 'running' && view && view.status !== 'running') void qc.invalidateQueries();
    was.current = view?.status;
  }, [view, qc]);
  const copyName = (service: string): string => copyNameOf(service, place?.get(service), shortName);
  const facts: PgSwitchoverFacts | null = c
    ? {
        cluster: c,
        standbys: c.primary.status !== 'running' ? [] : (repl.data?.standbys ?? null),
        // No running writer: the plan refuses on that alone (`no-writer`).
        apps: c.primary.status !== 'running' ? [] : (pooler.data?.apps ?? null),
        running: view?.status === 'running',
        copyName,
      }
    : null;
  return {
    run: view,
    running: view?.status === 'running',
    plan: (target?: string) => (facts ? planCopy(facts, target) : null),
    readError: repl.error?.message ?? pooler.error?.message ?? null,
    copyName,
    starting: start.isPending,
    start: (target: string) => start.mutate({ stack, cluster, target }),
  };
}

export type PgSwitchoverData = ReturnType<typeof usePgSwitchover>;
