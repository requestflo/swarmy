import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

type Topology = 'controller' | 'edge-per-node';

/** Mirrors `EdgeCertStorageView` (ingress.getConfig). */
export interface CertStorageState {
  mode: 'shared' | 'local';
  edges: number;
  objectStorageEnabled: boolean;
  bucket: string | null;
}

interface TopologyCardProps {
  topology: Topology;
  certStorage: CertStorageState;
}

const LABELS: Record<Topology, string> = {
  controller: 'Single controller',
  'edge-per-node': 'Edge on every ingress node',
};

function edgesPhrase(n: number): string {
  return n === 1 ? '1 edge' : `${n} edges`;
}

/**
 * Edge topology switch (geo-edge). A single controller serves every region
 * from one node; edge-per-node runs Caddy on every ingress-labelled node so
 * geo-DNS can steer each client to its own region. Swarm can't change a
 * service's mode in place, so the switch recreates the Caddy service — a
 * brief gap on 80/443, stated in the confirm.
 *
 * Edge-per-node needs ONE certificate store every edge shares (swarmy object
 * storage) — the server refuses the switch without it, so the card offers the
 * one-click "turn on object storage" first and shows the shared-pool state after.
 */
export function TopologyCard({ topology, certStorage }: TopologyCardProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const next: Topology = topology === 'controller' ? 'edge-per-node' : 'controller';
  const setTopology = useMutation(
    trpc.ingress.setTopology.mutationOptions({
      onSuccess: (view) => {
        toast.success(`Edge topology: ${LABELS[view.topology]}`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const setStoreDriver = useMutation(trpc.storage.setDriver.mutationOptions());
  const enableStore = useMutation(trpc.storage.enable.mutationOptions());
  const turningOn = setStoreDriver.isPending || enableStore.isPending;
  const turnOnObjectStorage = async (): Promise<void> => {
    try {
      await setStoreDriver.mutateAsync({ driver: 'garage' });
      await enableStore.mutateAsync();
      toast.success('Object storage is starting — the edges can share certificates once it is up');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      void qc.invalidateQueries();
    }
  };

  const needsStore = !certStorage.objectStorageEnabled;
  const switchBlocked = next === 'edge-per-node' && needsStore;

  return (
    <Card className="card-pop mt-6 border-0">
      <CardHeader>
        <CardTitle className="text-base">Edge topology</CardTitle>
        <CardDescription>
          A single controller serves every region from one node. Running the edge on every ingress
          node lets geo-DNS send each visitor to the closest region.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="default">{LABELS[topology]}</Badge>
          {topology === 'edge-per-node' && certStorage.mode === 'shared' ? (
            <Badge variant="muted">
              Certificates: shared across {edgesPhrase(certStorage.edges)} via swarmy object storage
            </Badge>
          ) : null}
        </div>

        {topology === 'edge-per-node' && certStorage.mode !== 'shared' ? (
          <p className="text-muted-foreground text-sm">
            {needsStore
              ? 'Each edge node is issuing its own certificates. With geo-DNS, a certificate authority ' +
                "checking from several places can reach a different node than the one that asked, so a new " +
                "domain's first certificate can fail. Turn on object storage so every edge shares one set."
              : 'Setting up shared certificates in swarmy object storage — this finishes on its own within a minute.'}
          </p>
        ) : null}

        {switchBlocked ? (
          <p className="text-muted-foreground text-sm">
            Every edge shares one set of certificates through swarmy object storage, so it needs to be on
            first.
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {needsStore ? (
            <Button onClick={() => void turnOnObjectStorage()} disabled={turningOn}>
              {turningOn ? 'Turning on…' : 'Turn on object storage'}
            </Button>
          ) : null}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" disabled={setTopology.isPending || switchBlocked}>
                {setTopology.isPending ? 'Switching…' : `Switch to ${LABELS[next].toLowerCase()}`}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Switch to {LABELS[next].toLowerCase()}?</AlertDialogTitle>
                <AlertDialogDescription>
                  The Caddy service is removed and recreated, so sites and the dashboard's https
                  address are unreachable for a few seconds while the new edge starts.
                  {next === 'edge-per-node'
                    ? ' Caddy will run on every node marked as ingress, and all of them share one set of ' +
                      'certificates in swarmy object storage. Each site gets its certificate issued once ' +
                      'more into the shared store on its first visit.'
                    : ' Caddy will run on one node only and keep certificates on that node. The shared ' +
                      'store is kept, so switching back reuses it.'}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep current</AlertDialogCancel>
                <AlertDialogAction onClick={() => setTopology.mutate({ topology: next })}>
                  Switch now
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardContent>
    </Card>
  );
}
