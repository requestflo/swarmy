import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ServerIcon } from 'lucide-react';
import { Button, EmptyState } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { CountUp } from '@/components/count-up';
import { ClusterHero } from './cluster-hero';
import { NodeCard } from './node-card';

/**
 * The Infrastructure plane — the cluster itself: live health KPIs + a grid of
 * node cards. Separate from the Applications plane (what you deploy); this is
 * what you deploy *onto*.
 */
export function InfrastructurePlane(): React.JSX.Element {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const nodes = useQuery({ ...trpc.nodes.list.queryOptions(), refetchInterval: 5_000 });
  const online = (nodes.data ?? []).filter((n) => n.status === 'online').length;
  const total = nodes.data?.length ?? 0;
  const allGreen = total > 0 && online === total;

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Infrastructure"
        title={
          allGreen ? (
            <>Your cluster's <em>healthy</em>.</>
          ) : (
            <><CountUp value={online} /> of {total} nodes <em>online</em>.</>
          )
        }
        description="Every machine in your swarm — capacity, health, and what runs where."
        actions={
          <Button onClick={() => navigate({ to: '/nodes/new' })}>
            <ServerIcon className="size-4" /> Add a node
          </Button>
        }
      />

      <ClusterHero />

      <div className="mt-8">
        <h2 className="mono-label mb-3">Nodes</h2>
        {total === 0 ? (
          <EmptyState
            icon={<ServerIcon className="size-6" />}
            title="No nodes yet"
            description="Add your first node and it'll appear here within seconds of the agent connecting."
            action={
              <Button onClick={() => navigate({ to: '/nodes/new' })}>
                <ServerIcon className="size-4" /> Add a node
              </Button>
            }
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {(nodes.data ?? []).map((node) => (
              <NodeCard key={node.id} node={node} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
