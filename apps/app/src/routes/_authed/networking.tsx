import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, StatusBadge, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { SectionHeader } from '@/components/section-header';
import { CountUp } from '@/components/count-up';
import {
  MeshDriverCard,
  DRIVER_LABELS,
  type MeshDriverId,
} from '@/components/networking/mesh-driver-card';
import { EnrollNodeCard } from '@/components/networking/enroll-node-card';
import { MeshPeersList } from '@/components/networking/mesh-peers-list';
import { ControlPlaneCard } from '@/components/networking/control-plane-card';
import { DirectConnectCard } from '@/components/networking/direct-connect-card';

export const Route = createFileRoute('/_authed/networking')({
  component: NetworkingPage,
});

function NetworkingPage(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const config = useQuery(trpc.mesh.getConfig.queryOptions());
  const peers = useQuery({
    ...trpc.mesh.listPeers.queryOptions(),
    refetchInterval: 10_000,
  });
  const nodes = useQuery(trpc.nodes.list.queryOptions());

  const invalidate = (): void => {
    void qc.invalidateQueries();
  };
  const setDriver = useMutation(
    trpc.mesh.setDriver.mutationOptions({ onSuccess: invalidate, onError: (e) => toast.error(e.message) }),
  );
  const setEnabled = useMutation(
    trpc.mesh.setEnabled.mutationOptions({ onSuccess: invalidate, onError: (e) => toast.error(e.message) }),
  );
  const enrollNode = useMutation(
    trpc.mesh.enrollNode.mutationOptions({
      onSuccess: () => {
        toast.success('Node enrolling in the mesh');
        invalidate();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const driver = (config.data?.driver ?? 'none') as MeshDriverId;
  const isNone = driver === 'none';
  const enabled = !!config.data?.enabled;
  const live = enabled && !isNone;
  const peerCount = peers.data?.length ?? 0;
  const [enrollNodeId, setEnrollNodeId] = React.useState('');

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <SectionHeader
        section="Platform"
        title={
          peerCount > 0 ? (
            <>
              <CountUp value={peerCount} /> peer{peerCount === 1 ? '' : 's'} <em>meshed</em>.
            </>
          ) : (
            <>
              One mesh, <em>anywhere</em>.
            </>
          )
        }
        description="Join every node to one encrypted WireGuard mesh — any cloud, any NAT, no open ports. Or leave it off and keep your own network."
        actions={
          <div className="flex items-center gap-3">
            <StatusBadge
              tone={live ? 'online' : 'neutral'}
              label={live ? `${DRIVER_LABELS[driver]} · live` : isNone ? 'None · default' : 'Paused'}
            />
            {!live && !isNone && (
              <Button onClick={() => setEnabled.mutate({ enabled: true })} disabled={setEnabled.isPending}>
                Enable mesh
              </Button>
            )}
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <MeshDriverCard
          driver={driver}
          enabled={enabled}
          isNone={isNone}
          onDriverChange={(d) => setDriver.mutate({ driver: d })}
          onEnabledChange={(v) => setEnabled.mutate({ enabled: v })}
        />
        <EnrollNodeCard
          active={live}
          nodes={nodes.data ?? []}
          enrollNodeId={enrollNodeId}
          onEnrollNodeIdChange={setEnrollNodeId}
          onEnroll={(nodeId) => enrollNode.mutate({ nodeId })}
          isPending={enrollNode.isPending}
        />
      </div>

      {!isNone && (
        <div className="mt-4">
          <ControlPlaneCard driver={driver} />
        </div>
      )}

      <MeshPeersList peers={peers.data ?? []} />

      {live && <DirectConnectCard />}
    </div>
  );
}
