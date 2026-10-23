import * as React from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import type { NodeSummary } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';

export interface MemberServers {
  /** Service name → the servers it has a copy on; undefined until every server answered. */
  byService: Map<string, NodeSummary[]> | undefined;
  nodes: NodeSummary[] | undefined;
}

/**
 * Which servers a managed cluster's members run on: `services.list({ nodeId,
 * search })` per server (the placement filter the Servers page uses), scoped
 * by name to the cluster's members (`storefront_checkout-…`). Offline servers
 * run nothing, so they're skipped.
 */
export function useMemberServers(prefix: string, enabled = true): MemberServers {
  const trpc = useTRPC();
  const nodes = useQuery({ ...trpc.nodes.list.queryOptions(), refetchInterval: 15_000, enabled });
  const online = (nodes.data ?? []).filter((n) => n.status !== 'offline');
  const perNode = useQueries({
    queries: online.map((n) => ({
      ...trpc.services.list.queryOptions({ nodeId: n.id, search: prefix }),
      refetchInterval: 15_000,
      enabled,
    })),
  });
  const settled = nodes.data !== undefined && perNode.every((q) => q.data !== undefined);
  const key = perNode.map((q) => q.dataUpdatedAt).join('|');

  const byService = React.useMemo(() => {
    if (!settled) return undefined;
    const out = new Map<string, NodeSummary[]>();
    online.forEach((node, i) => {
      for (const svc of perNode[i]?.data ?? []) {
        const list = out.get(svc.name) ?? [];
        if (!list.some((n) => n.id === node.id)) list.push(node);
        out.set(svc.name, list);
      }
    });
    return out;
    // `key` stands in for the per-node query identities.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, nodes.data, key]);

  return { byService, nodes: nodes.data };
}

/** "wkr-1" / "wkr-1 and mgr-2" / "mgr-1, mgr-2 and wkr-1". */
export function serverList(nodes: NodeSummary[] | undefined): string | null {
  const names = (nodes ?? []).map((n) => n.name);
  if (names.length === 0) return null;
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
