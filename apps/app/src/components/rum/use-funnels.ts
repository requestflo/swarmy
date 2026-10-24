import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import type { FunnelDraft } from './funnel-model';

/** This app's funnel definitions (the `swarmy.rum.funnels` label). */
export function useFunnels(stack: string) {
  const trpc = useTRPC();
  // A refetch right after a save could read the inventory before the label lands.
  return useQuery({ ...trpc.rum.getFunnels.queryOptions({ stack }), staleTime: 10_000 });
}

/** One funnel's counts over the page's window; off until a funnel is chosen. */
export function useFunnel(stack: string, funnel: string | null, days: number, signedIn: boolean) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.rum.funnel.queryOptions({ stack, funnel: funnel ?? '', days, signedIn }),
    enabled: funnel !== null,
    refetchInterval: 60_000,
  });
}

/** Replace the app's funnel list; the answer is what was saved. */
export function useSaveFunnels(stack: string) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const m = useMutation(
    trpc.rum.setFunnels.mutationOptions({
      onSuccess: (data) => {
        qc.setQueryData(trpc.rum.getFunnels.queryKey({ stack }), data);
        void qc.invalidateQueries({ queryKey: trpc.rum.funnel.queryKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  return {
    pending: m.isPending,
    save: (funnels: FunnelDraft[], onDone?: () => void) => m.mutate({ stack, funnels }, { onSuccess: () => onDone?.() }),
  };
}

/** Unresolved issues for the drop's "See the error" link; idle unless asked. */
export function useDropIssues(stack: string, enabled: boolean) {
  const trpc = useTRPC();
  return useQuery({ ...trpc.errors.issues.queryOptions({ stack, status: 'unresolved', sort: 'count', limit: 20 }), enabled });
}
