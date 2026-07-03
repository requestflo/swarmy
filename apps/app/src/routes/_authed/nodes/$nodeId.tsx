import * as React from 'react';
import { createFileRoute, useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { useRolling } from '@/components/charts';
import { NodeActions } from '@/components/nodes/node-actions';
import { NodeLivePanel } from '@/components/nodes/node-live-panel';
import { NodeDetailsPanel } from '@/components/nodes/node-details-panel';
import { NodeContainersPanel } from '@/components/nodes/node-containers-panel';
import { NodeControlsPanel } from '@/components/nodes/node-controls-panel';

export const Route = createFileRoute('/_authed/nodes/$nodeId')({
  component: NodeDetailPage,
});

function NodeDetailPage(): React.JSX.Element {
  const trpc = useTRPC();
  const { nodeId } = useParams({ from: '/_authed/nodes/$nodeId' });

  const node = useQuery({ ...trpc.nodes.get.queryOptions({ id: nodeId }), refetchInterval: 5_000 });
  const live = useQuery({
    ...trpc.nodes.liveStatsLatest.queryOptions({ nodeId }),
    refetchInterval: 2_000,
  });
  const containers = useQuery({
    ...trpc.nodes.containers.queryOptions({ nodeId }),
    refetchInterval: 5_000,
  });
  const costs = useQuery({ ...trpc.cost.overview.queryOptions(), refetchInterval: 5_000 });

  const point = React.useMemo(
    () =>
      live.data
        ? {
            t: new Date().toLocaleTimeString(),
            cpu: Number(live.data.cpuPercent.toFixed(1)),
            mem: live.data.memTotalBytes
              ? Number(((live.data.memUsedBytes / live.data.memTotalBytes) * 100).toFixed(1))
              : 0,
          }
        : undefined,
    [live.dataUpdatedAt, live.data],
  );
  const trend = useRolling(point, 60);

  const n = node.data;
  const monthlyUsd = costs.data?.nodes.find((c) => c.nodeId === nodeId)?.monthlyUsd ?? null;

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Infrastructure · Node"
        title={
          <>
            {n?.name ?? 'Node'} is <em>{n?.status ?? 'unknown'}</em>.
          </>
        }
        description={
          n ? `${n.hostname} · ${n.engineVersion ?? 'docker'} · ${n.os ?? ''}` : undefined
        }
        actions={<NodeActions nodeId={nodeId} />}
      />

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <NodeLivePanel live={live.data} trend={trend} />
        <NodeDetailsPanel node={n} live={live.data} />
      </div>

      <NodeControlsPanel node={n} monthlyUsd={monthlyUsd} />
      <NodeContainersPanel containers={containers.data} />
    </div>
  );
}
