import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import type { RouteProtection } from '@/components/ingress/protection-model';
import type { StackDomain } from '@/components/ingress/stack-domain-row';

/** The per-route fields the Domains tab changes (`undefined` removes one). */
export interface RouteFields {
  protection?: RouteProtection | undefined;
  driver?: string | undefined;
}

/**
 * Change one route. The `swarmy.ingress.routes` label carries the service's
 * WHOLE route set, so read it fresh, patch this route (host + path identify
 * it) and write the full array back. Resolves true once saved.
 */
export function useRoutePatch(d: StackDomain): { patch: (fields: RouteFields, done: string) => Promise<boolean>; saving: boolean } {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const setRoutes = useMutation(trpc.ingress.setServiceRoutes.mutationOptions());
  const [saving, setSaving] = React.useState(false);

  const patch = async (fields: RouteFields, done: string): Promise<boolean> => {
    setSaving(true);
    try {
      const routes = await qc.fetchQuery({ ...trpc.ingress.listServiceRoutes.queryOptions({ serviceId: d.serviceId }), staleTime: 0 });
      const patched = routes.map((r) => (r.host === d.host && (r.path ?? null) === d.pathPrefix ? { ...r, ...fields } : r));
      await setRoutes.mutateAsync({ serviceId: d.serviceId, routes: patched });
      toast.success(done);
      await qc.invalidateQueries();
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  return { patch, saving };
}
