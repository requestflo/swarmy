import * as React from 'react';
import type { RouteProtection } from '@/components/ingress/protection-model';
import type { StackDomain } from '@/components/ingress/stack-domain-row';
import { useRoutePatch } from './use-route-patch';

/**
 * Save one route's protection — the same update the protection editor
 * makes (the whole route set, this route patched). Until the list re-reads,
 * the saved value shows.
 */
export function useRouteProtection(d: StackDomain): {
  protection: RouteProtection | null;
  save: (next: RouteProtection | null, done?: string) => void;
  saving: boolean;
} {
  const { patch, saving } = useRoutePatch(d);
  const [shown, setShown] = React.useState<{ p: RouteProtection | null } | null>(null);

  const save = (next: RouteProtection | null, done = 'Protections saved'): void => {
    setShown({ p: next });
    void patch({ protection: next ?? undefined }, done).finally(() => setShown(null));
  };

  return { protection: shown ? shown.p : d.protection, save, saving };
}
