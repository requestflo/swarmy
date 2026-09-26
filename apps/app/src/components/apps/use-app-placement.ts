import * as React from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import type { Inventory, NodeSummary } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';

export interface Placement {
  nodes: NodeSummary[] | undefined;
  /** app (stack) name → the servers its copies run on; undefined until every server answered. */
  byApp: Map<string, NodeSummary[]> | undefined;
}

/**
 * Which servers each app runs on: `services.list({ nodeId })` per server
 * (the same placement filter the Servers page uses), folded onto stacks
 * through the live inventory. Offline servers run nothing, so they're skipped.
 */
export function useAppPlacement(inventory: Inventory | undefined): Placement {
  const trpc = useTRPC();
  const nodes = useQuery({ ...trpc.nodes.list.queryOptions(), refetchInterval: 15_000 });
  const online = (nodes.data ?? []).filter((n) => n.status !== 'offline');
  const perNode = useQueries({
    queries: online.map((n) => ({
      ...trpc.services.list.queryOptions({ nodeId: n.id }),
      refetchInterval: 15_000,
    })),
  });
  const settled = nodes.data !== undefined && perNode.every((q) => q.data !== undefined);
  const key = perNode.map((q) => q.dataUpdatedAt).join('|');

  const byApp = React.useMemo(() => {
    if (!settled || !inventory) return undefined;
    const stackOf = new Map(inventory.services.map((s) => [s.id, s.stack]));
    const out = new Map<string, NodeSummary[]>();
    online.forEach((node, i) => {
      for (const svc of perNode[i]?.data ?? []) {
        const stack = stackOf.get(svc.id) ?? svc.stackId;
        if (!stack) continue;
        const list = out.get(stack) ?? [];
        if (!list.some((n) => n.id === node.id)) list.push(node);
        out.set(stack, list);
      }
    });
    return out;
    // `key` stands in for the per-node query identities.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, inventory, nodes.data, key]);

  return { nodes: nodes.data, byApp };
}
