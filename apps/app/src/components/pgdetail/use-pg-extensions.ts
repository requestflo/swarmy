import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { restartClause } from './pg-extension-words';

/**
 * `db.extensions` (polled faster while the reconcile is restarting copies)
 * and `db.setExtension`, which only declares the change: the toast says what
 * the reconcile will do next.
 */
export function usePgExtensions(stack: string, cluster: string) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const q = useQuery({
    ...trpc.db.extensions.queryOptions({ stack, cluster }),
    refetchInterval: (query) => (query.state.data?.progress ? 4_000 : 15_000),
  });
  const set = useMutation(
    trpc.db.setExtension.mutationOptions({
      onSuccess: (r) => {
        const v = q.data;
        if (!r.changed) toast.info(`${r.name} is already ${r.on ? 'on' : 'off'}`);
        else if (r.restartsCopies && v) toast.success(`${r.name} is turning ${r.on ? 'on' : 'off'}: swarmy ${restartClause(v)}.`);
        else toast.success(`${r.name} is turning ${r.on ? 'on' : 'off'} in ${cluster}`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  return {
    view: q.data ?? null,
    pending: q.isPending,
    error: q.error,
    saving: set.isPending,
    toggle: (name: 'pg_stat_statements' | 'postgis', on: boolean) => set.mutate({ stack, cluster, name, on }),
  };
}
