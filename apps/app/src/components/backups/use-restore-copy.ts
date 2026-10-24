import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';
import { restoreCopyName } from '@swarmy/core';
import { toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/** What `dbBackups.restoreAsCopy` made (the fields the page shows). */
export interface RestoreCopyDone {
  bytesRestored: string;
  recoveredTo?: string;
  copy: { stack: string; cluster: string; primaryService: string; rwHost: string };
}

/**
 * "Restore as a copy" of one managed Postgres: the name of the database it
 * will create (the controller's own rule, `restoreCopyName`, checked against
 * this app's databases), the restore itself (`dbBackups.restoreAsCopy`:
 * creates it, waits for it, loads the save) and "Remove the copy"
 * (`db.remove`, its data too: it is a copy). The latest restore is read from
 * the mutation cache, so a page that re-mounts when the copy appears in its
 * lists still shows it running, then what it made.
 */
export function useRestoreCopy(stack: string, cluster: string) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const overview = useQuery({ ...trpc.dbBackups.overview.queryOptions(), refetchInterval: 30_000 });
  const taken = (overview.data ?? []).filter((r) => r.stack === stack).map((r) => r.cluster);
  const name = restoreCopyName(cluster, new Date(), taken);

  const restore = useMutation(
    trpc.dbBackups.restoreAsCopy.mutationOptions({
      onSuccess: () => void qc.invalidateQueries(),
      onError: (e) => toast.error(`Couldn’t restore a copy of ${cluster}`, { description: e.message, duration: 10_000 }),
    }),
  );
  const latest = useMutationState({
    filters: {
      mutationKey: trpc.dbBackups.restoreAsCopy.mutationKey(),
      predicate: (m) => {
        const v = m.state.variables as { stack?: string; cluster?: string } | undefined;
        return v?.stack === stack && v?.cluster === cluster;
      },
    },
    select: (m) => m.state,
  }).at(-1);
  // Removing a copy is remembered the same way, so the page never offers to remove one twice.
  const removals = useMutationState({
    filters: { mutationKey: trpc.db.remove.mutationKey(), status: 'success' },
    select: (m) => ({ v: m.state.variables as { stack?: string; cluster?: string } | undefined, at: m.state.submittedAt }),
  });
  const made = latest?.status === 'success' ? (latest.data as RestoreCopyDone) : null;
  const gone = made != null && removals.some((r) => r.v?.stack === stack && r.v.cluster === made.copy.cluster && r.at >= (latest?.submittedAt ?? 0));
  const remove = useMutation(
    trpc.db.remove.mutationOptions({
      onSuccess: (r) => {
        toast.success(`Removed ${r.cluster}`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error('Couldn’t remove the copy', { description: e.message, duration: 10_000 }),
    }),
  );

  return {
    /** The database a restore now would create. */
    name,
    /** The app's databases are known, so `name` is really free. */
    ready: overview.isSuccess,
    restore,
    /** The latest copy restore of this database: running (with the name it creates), or what it made. */
    running: latest?.status === 'pending' ? ((latest.variables as { name?: string } | undefined)?.name ?? name) : null,
    done: gone ? null : made,
    /** The copy that was made and then removed. */
    removed: gone ? made.copy.cluster : null,
    remove,
    removeCopy: (copy: string): void => remove.mutate({ stack, cluster: copy, confirm: `${stack}/${copy}`, deleteData: true }),
  };
}

export type RestoreCopy = ReturnType<typeof useRestoreCopy>;
