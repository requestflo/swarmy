import * as React from 'react';
import { useQueries } from '@tanstack/react-query';
import { isNat } from '@/components/nodes/servers/fleet/fleet-model';
import { useTRPC } from '@/integrations/trpc';

/**
 * The servers behind NAT, from each one's `swarmy.node.reachability` label
 * (the operator's override wins) — the agent detects it and the controller
 * stamps it. Read through `nodes.get`, the way the Servers map does.
 */
export function useNatNodes(ids: string[]): Set<string> {
  const trpc = useTRPC();
  const details = useQueries({
    queries: ids.map((id) => ({ ...trpc.nodes.get.queryOptions({ id }), staleTime: 60_000 })),
  });
  const key = details.map((d) => d.dataUpdatedAt).join('|');
  return React.useMemo(
    () => new Set(details.flatMap((d) => (d.data && isNat(d.data.labels) ? [d.data.id] : []))),
    // key stands in for the per-server detail identities.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
}
