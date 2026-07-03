import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { CrownIcon, PlusIcon, ServerIcon } from 'lucide-react';
import { Button, Card, CardContent, CardHeader, CardTitle, EmptyState } from '@swarmy/ui';
import type { NodeSummary } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { NodeRow } from './node-row';

/**
 * The Nodes index's PRIMARY surface: one flat card, two quiet groups
 * ("Control plane" for managers, "Workers" for the rest), each a hairline
 * list of `NodeRow`s. This is the single legible answer to "which node is in
 * control" — the canvas/globe below is a secondary, optional view.
 */
export function NodeList(): React.JSX.Element {
  const trpc = useTRPC();
  const nodes = useQuery({ ...trpc.nodes.list.queryOptions(), refetchInterval: 5_000 });
  const costs = useQuery({ ...trpc.cost.overview.queryOptions(), refetchInterval: 5_000 });
  const counts = useQuery({ ...trpc.nodes.containerCounts.queryOptions(), refetchInterval: 5_000 });

  const costByNode = React.useMemo(() => {
    const map = new Map<string, number | null>();
    for (const n of costs.data?.nodes ?? []) map.set(n.nodeId, n.monthlyUsd);
    return map;
  }, [costs.data]);

  const rows = nodes.data ?? [];
  const managers = rows.filter((n) => n.role === 'manager');
  const workers = rows.filter((n) => n.role !== 'manager');

  if (!nodes.isLoading && rows.length === 0) {
    return (
      <Card className="card-pop border-0">
        <CardContent className="pt-6">
          <EmptyState
            icon={<ServerIcon />}
            title="No nodes yet — add one."
            description="Mint a join token and paste one line on a fresh box to grow the swarm."
            action={
              <Button asChild className="font-bold">
                <Link to="/nodes/new">
                  <PlusIcon className="size-4" /> Add a node
                </Link>
              </Button>
            }
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          <span>Cluster nodes</span>
          <span className="mono-data text-muted-foreground text-xs font-normal">
            {rows.length} node{rows.length === 1 ? '' : 's'}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="divide-border grid divide-y">
        <NodeGroup label="Control plane" icon={<CrownIcon className="size-3.5" />} nodes={managers} costByNode={costByNode} counts={counts.data} />
        <NodeGroup label="Workers" icon={<ServerIcon className="size-3.5" />} nodes={workers} costByNode={costByNode} counts={counts.data} />
      </CardContent>
    </Card>
  );
}

interface NodeGroupProps {
  label: string;
  icon: React.ReactNode;
  nodes: NodeSummary[];
  costByNode: Map<string, number | null>;
  counts: Record<string, number> | undefined;
}

function NodeGroup({ label, icon, nodes, costByNode, counts }: NodeGroupProps): React.JSX.Element | null {
  if (nodes.length === 0) return null;
  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <p className="text-muted-foreground mono-label mb-1.5 flex items-center gap-1.5 px-4">
        {icon} {label} <span className="mono-data">{nodes.length}</span>
      </p>
      <div className="divide-border grid divide-y">
        {nodes.map((n) => (
          <NodeRow
            key={n.id}
            node={n}
            monthlyUsd={costByNode.get(n.id) ?? null}
            containerCount={counts?.[n.id] ?? null}
          />
        ))}
      </div>
    </div>
  );
}
