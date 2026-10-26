import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { planAppRestore, type AppRestorePlan, type AppRestoreScopeView } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import type { TimeTravelData } from './use-time-travel';

const PHYSICAL = new Set(['wal-g', 'pgbackrest']);

export interface AppRestore {
  scope: AppRestoreScopeView | undefined;
  /** The plan for the head; null until the scope and every database's saves are in. */
  plan: AppRestorePlan | null;
  error: unknown;
  restore: (confirm: string) => void;
  running: boolean;
  result: ReturnType<typeof useRestoreMutation>['data'];
  failure: Error | null;
  reset: () => void;
}

function useRestoreMutation() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  return useMutation(trpc.backups.restoreApp.mutationOptions({ onSettled: () => qc.invalidateQueries() }));
}

/**
 * The whole-app restore at the head: what it covers (`backups.appRestoreScope`),
 * the plan from the lists the page already has (the same pure planner the
 * controller runs again before it touches anything), and the restore itself.
 */
export function useAppRestore(stack: string, d: TimeTravelData, at: number): AppRestore {
  const trpc = useTRPC();
  const scope = useQuery({ ...trpc.backups.appRestoreScope.queryOptions({ stack }), refetchInterval: 60_000 });
  const mutation = useRestoreMutation();
  const s = scope.data;
  const plan = React.useMemo((): AppRestorePlan | null => {
    if (!s) return null;
    const dbs = s.databases.map((c) => d.databases.find((x) => x.row.cluster === c));
    if (dbs.some((x) => x !== undefined && x.saves === undefined)) return null;
    return planAppRestore({
      at,
      volumes: s.volumes.map((v) => ({ volume: v, saves: d.snapshots.filter((x) => x.volume === v) })),
      databases: s.databases.map((cluster, i) => {
        const row = dbs[i]?.row;
        const pitr = row?.pitr && row.engine && PHYSICAL.has(row.engine) ? { engine: row.engine, window: row.pitrWindow } : null;
        return { cluster, saves: dbs[i]?.saves ?? [], pitr };
      }),
    });
  }, [s, d.databases, d.snapshots, at]);

  return {
    scope: s,
    plan,
    error: scope.error,
    restore: (confirm) => mutation.mutate({ stack, at: new Date(at).toISOString(), confirm }),
    running: mutation.isPending,
    result: mutation.data,
    failure: mutation.error as Error | null,
    reset: mutation.reset,
  };
}
