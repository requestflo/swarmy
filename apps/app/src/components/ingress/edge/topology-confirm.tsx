import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, toast } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { TOPOLOGY_LABEL, type Topology } from './topology-model';

/**
 * "Switch over / Keep current" for the topology being previewed. The same
 * preflight as `ingress.setTopology` is said up front: admins only, and an
 * edge on every server needs a server marked as an edge and object storage
 * (one shared set of certificates) — with the one-click way to turn it on.
 */
export function TopologyConfirm({
  next,
  admin,
  objectStorage,
  anyEdge,
  onDone,
}: {
  next: Topology;
  admin: boolean | undefined;
  objectStorage: boolean;
  anyEdge: boolean;
  onDone: () => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const setTopology = useMutation(
    trpc.ingress.setTopology.mutationOptions({
      onSuccess: (v) => {
        toast.success(`Front door: ${TOPOLOGY_LABEL[v.topology].toLowerCase()}`);
        void qc.invalidateQueries();
        onDone();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const setStoreDriver = useMutation(trpc.storage.setDriver.mutationOptions());
  const enableStore = useMutation(trpc.storage.enable.mutationOptions());
  const turningOn = setStoreDriver.isPending || enableStore.isPending;
  const turnOnStore = async (): Promise<void> => {
    try {
      await setStoreDriver.mutateAsync({ driver: 'garage' });
      await enableStore.mutateAsync();
      toast.success('Object storage is starting. The edges can share certificates once it is up.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      void qc.invalidateQueries();
    }
  };

  const perNode = next === 'edge-per-node';
  const blocker =
    admin === false
      ? 'Only an owner or admin can move the front door.'
      : perNode && !anyEdge
        ? 'Mark at least one server as an edge first (below), so there is somewhere to run it.'
        : perNode && !objectStorage
          ? 'Every edge shares one set of certificates through swarmy object storage, so it needs to be on first.'
          : null;

  return (
    <div role="region" aria-label="Switch the front door" className="border-primary/40 bg-primary/[0.04] flex flex-col gap-2 rounded-xl border px-4 py-3">
      <p className="text-[14px] font-semibold">Switch to {TOPOLOGY_LABEL[next].toLowerCase()}?</p>
      <p className="text-muted-foreground text-[13px] leading-relaxed">
        The front door restarts, so your sites are unreachable for a few seconds while the new edge starts.{' '}
        {perNode
          ? 'Every edge shares one set of certificates, so each site gets its certificate once more into the shared set on its first visit.'
          : 'Certificates stay on that one server; the shared set is kept, so switching back reuses it.'}
      </p>
      {blocker ? <p className="text-tone-warn text-[13px]">{blocker}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        {perNode && !objectStorage && admin !== false ? (
          <Button variant="outline" onClick={() => void turnOnStore()} disabled={turningOn}>
            {turningOn ? 'Turning on…' : 'Turn on object storage'}
          </Button>
        ) : null}
        <Button onClick={() => setTopology.mutate({ topology: next })} disabled={!!blocker || setTopology.isPending}>
          {setTopology.isPending ? 'Switching…' : 'Switch over'}
        </Button>
        <Button variant="outline" onClick={onDone} disabled={setTopology.isPending}>
          Keep current
        </Button>
      </div>
      <Tech>{`ingress.setTopology { topology: '${next}' } · Swarm can't change a service's mode in place, so swarmy-ingress-caddy is removed and recreated`}</Tech>
    </div>
  );
}
