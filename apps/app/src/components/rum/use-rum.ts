import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import type { RumSettings, RumSettingsView } from './rum-shared';

/** This app's RUM settings (+ its routes and which stores exist). */
export function useRumSettings(stack: string) {
  const trpc = useTRPC();
  return useQuery(trpc.rum.getSettings.queryOptions({ stack }));
}

/** Owners and admins can change settings and erase data. */
export function useIsOrgAdmin(): boolean {
  const trpc = useTRPC();
  const org = useQuery(trpc.org.currentOrg.queryOptions());
  return org.data?.role === 'owner' || org.data?.role === 'admin';
}

/**
 * Save a partial settings change. Applies optimistically — the edge picks it
 * up without a redeploy, so the page should feel instant too.
 */
export function useSaveRumSettings(stack: string) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const key = trpc.rum.getSettings.queryKey({ stack });
  const m = useMutation(
    trpc.rum.setSettings.mutationOptions({
      onMutate: (v) => {
        const prev = qc.getQueryData<RumSettingsView>(key);
        if (prev) qc.setQueryData<RumSettingsView>(key, { ...prev, settings: { ...prev.settings, ...v.settings } });
        return { prev };
      },
      onSuccess: (data) => {
        qc.setQueryData(key, data);
        void qc.invalidateQueries({ queryKey: trpc.rum.analytics.queryKey() });
      },
      onError: (e, _v, c) => {
        const prev = (c as { prev?: RumSettingsView } | undefined)?.prev;
        if (prev) qc.setQueryData(key, prev);
        toast.error(e.message);
      },
    }),
  );
  return {
    pending: m.isPending,
    save: (current: RumSettings, patch: Partial<RumSettings>) =>
      m.mutate({ stack, settings: { ...current, ...patch } }),
  };
}

/** Flip one route's own toggle (null = follow the app). */
export function useSetRumRoute(stack: string) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  return useMutation(
    trpc.rum.setRoute.mutationOptions({
      onSuccess: (data) => qc.setQueryData(trpc.rum.getSettings.queryKey({ stack }), data),
      onError: (e) => toast.error(e.message),
    }),
  );
}
