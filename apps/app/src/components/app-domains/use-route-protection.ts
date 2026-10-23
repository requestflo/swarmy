import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import type { RouteProtection } from '@/components/ingress/protection-model';
import type { StackDomain } from '@/components/ingress/stack-domain-row';

/**
 * Save one route's protection. The `swarmy.ingress.routes` label carries the
 * service's WHOLE route set, so read it fresh, patch this route (host + path
 * identify it) and write the full array back — the same update the
 * protection editor makes. Until the list re-reads, the saved value shows.
 */
export function useRouteProtection(d: StackDomain): {
  protection: RouteProtection | null;
  save: (next: RouteProtection | null, done?: string) => void;
  saving: boolean;
} {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [shown, setShown] = React.useState<{ p: RouteProtection | null } | null>(null);
  const setRoutes = useMutation(trpc.ingress.setServiceRoutes.mutationOptions());
  const [saving, setSaving] = React.useState(false);

  const save = (next: RouteProtection | null, done = 'Protections saved'): void => {
    setShown({ p: next });
    setSaving(true);
    void (async () => {
      try {
        const routes = await qc.fetchQuery({ ...trpc.ingress.listServiceRoutes.queryOptions({ serviceId: d.serviceId }), staleTime: 0 });
        const patched = routes.map((r) =>
          r.host === d.host && (r.path ?? null) === d.pathPrefix ? { ...r, protection: next ?? undefined } : r,
        );
        await setRoutes.mutateAsync({ serviceId: d.serviceId, routes: patched });
        toast.success(done);
        await qc.invalidateQueries();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      } finally {
        setShown(null);
        setSaving(false);
      }
    })();
  };

  return { protection: shown ? shown.p : d.protection, save, saving };
}
