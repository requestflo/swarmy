import * as React from 'react';
import { createFileRoute, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { useRolling } from '@/components/charts';
import { NodeActions } from '@/components/nodes/node-actions';
import { NodeLivePanel } from '@/components/nodes/node-live-panel';
import { NodeDetailsPanel } from '@/components/nodes/node-details-panel';
import { NodeContainersPanel } from '@/components/nodes/node-containers-panel';

export const Route = createFileRoute('/_authed/nodes/$nodeId')({
  component: NodeDetailPage,
});

function NodeDetailPage(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { nodeId } = useParams({ from: '/_authed/nodes/$nodeId' });

  const node = useQuery(trpc.nodes.get.queryOptions({ id: nodeId }));
  const live = useQuery({
    ...trpc.nodes.liveStatsLatest.queryOptions({ nodeId }),
    refetchInterval: 2_000,
  });
  const containers = useQuery({
    ...trpc.nodes.containers.queryOptions({ nodeId }),
    refetchInterval: 5_000,
  });

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

  const drain = useMutation(
    trpc.nodes.drain.mutationOptions({
      onSuccess: () => {
        toast.success('Node draining');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const activate = useMutation(
    trpc.nodes.activate.mutationOptions({
      onSuccess: () => {
        toast.success('Node activated');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const n = node.data;
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
        actions={
          <NodeActions
            nodeId={nodeId}
            draining={drain.isPending}
            activating={activate.isPending}
            onDrain={() => drain.mutate({ id: nodeId })}
            onActivate={() => activate.mutate({ id: nodeId })}
          />
        }
      />

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <NodeLivePanel live={live.data} trend={trend} />
        <NodeDetailsPanel node={n} live={live.data} />
      </div>

      <NodeContainersPanel containers={containers.data} />
    </div>
  );
}
