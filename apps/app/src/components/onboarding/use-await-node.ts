import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { NodeSummary } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';

export interface AwaitedNode {
  node: NodeSummary;
  /** When the dashboard first saw it online (polled every 3 s). */
  at: Date;
}

/**
 * Polls `nodes.list` and resolves the first node that appears (or comes online)
 * after the watch arms. Snapshots the node ids online at arming so only a
 * genuinely new arrival counts — the "watch it phone home" moment.
 *
 * `armKey` is the join link's id: null watches nothing, and a new link (Add
 * another) starts a fresh watch. Also returns the servers already there, for
 * the radar's blips.
 */
export function useAwaitNode(armKey: string | null): { arrived: AwaitedNode | null; nodes: NodeSummary[] | undefined } {
  const trpc = useTRPC();
  const armed = armKey !== null;
  const nodes = useQuery({
    ...trpc.nodes.list.queryOptions(),
    refetchInterval: armed ? 3_000 : false,
  });

  const baseline = React.useRef<Set<string> | null>(null);
  const [arrived, setArrived] = React.useState<AwaitedNode | null>(null);

  // Every new link (or none) watches anew.
  React.useEffect(() => {
    baseline.current = null;
    setArrived(null);
  }, [armKey]);

  React.useEffect(() => {
    if (!armed || !nodes.data) return;
    const online = nodes.data.filter((n) => n.status === 'online');
    if (baseline.current === null) {
      // First sample after arming: everything already online is "old".
      baseline.current = new Set(online.map((n) => n.id));
      return;
    }
    if (arrived) return;
    const fresh = online.find((n) => !baseline.current?.has(n.id));
    if (fresh) setArrived({ node: fresh, at: new Date() });
  }, [armed, nodes.data, arrived]);

  // Keep the arrival's facts current (role and size settle after it registers).
  const node = arrived ? (nodes.data?.find((n) => n.id === arrived.node.id) ?? arrived.node) : null;
  return { arrived: arrived && node ? { node, at: arrived.at } : null, nodes: nodes.data };
}
