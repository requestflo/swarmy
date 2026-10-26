import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { shortName } from './pg-topology';

/**
 * `db.pooler` (faster while the reconcile is converging it), `db.setPooler`
 * (only declares; the toast says what happens next) and moving one app onto
 * or off the pooler (`db.inject` with `via`, which redeploys that app).
 */
export function usePgPooler(stack: string, cluster: string) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const q = useQuery({
    ...trpc.db.pooler.queryOptions({ stack, cluster }),
    refetchInterval: (query) => (query.state.data?.converging ? 4_000 : 15_000),
    retry: false,
  });
  const set = useMutation(
    trpc.db.setPooler.mutationOptions({
      onSuccess: (r) => {
        if (!r.changed) toast.info(`The pooler is already ${r.pooler ? 'set that way' : 'off'}`);
        else if (r.pooler) toast.success(`${shortName(r.service)} is on its way: ${r.pooler.mode} mode, ${r.pooler.poolSize} connections per database`);
        else toast.success(`${shortName(r.service)} is being removed`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const inject = useMutation(
    trpc.db.inject.mutationOptions({
      onSuccess: (r) => {
        toast.success(`${shortName(r.appService)} now connects ${r.via === 'pooler' ? 'through the pooler' : 'directly'}; it is redeploying`);
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
    set: (input: { enabled: boolean; mode?: 'transaction' | 'session'; poolSize?: number }) => set.mutate({ stack, cluster, ...input }),
    moving: inject.isPending ? (inject.variables?.appService ?? null) : null,
    connect: (app: { service: string; envVar: string }, via: 'direct' | 'pooler') => inject.mutate({ stack, cluster, appService: app.service, envVar: app.envVar, via }),
  };
}

export type PgPoolerData = ReturnType<typeof usePgPooler>;
