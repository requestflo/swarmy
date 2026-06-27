import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';

export interface AwaitedNode {
  id: string;
  name: string;
}

/**
 * Polls `nodes.list` and resolves the first node that appears (or comes online)
 * after this hook mounts. Snapshots the node ids present at mount so we only
 * react to genuinely new arrivals — the "watch it connect" moment.
 *
 * `armed` gates polling so we only watch once the user has a token to paste.
 */
export function useAwaitNode(armed: boolean): AwaitedNode | null {
  const trpc = useTRPC();
  const nodes = useQuery({
    ...trpc.nodes.list.queryOptions(),
    refetchInterval: armed ? 3_000 : false,
  });

  const baseline = React.useRef<Set<string> | null>(null);
  const [arrived, setArrived] = React.useState<AwaitedNode | null>(null);

  // Reset the baseline whenever we (re)arm so a fresh paste watches anew.
  React.useEffect(() => {
    if (!armed) {
      baseline.current = null;
      setArrived(null);
    }
  }, [armed]);

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
    if (fresh) setArrived({ id: fresh.id, name: fresh.name });
  }, [armed, nodes.data, arrived]);

  return arrived;
}
