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

interface TopologyCardProps {
  topology: Topology;
  /** Whether shared (Redis) certificate storage is configured. */
  haConfigured: boolean;
}

const LABELS: Record<Topology, string> = {
  controller: 'Single controller',
  'edge-per-node': 'Edge on every ingress node',
};

/**
 * Edge topology switch (geo-edge). A single controller serves every region
 * from one node; edge-per-node runs Caddy on every ingress-labelled node so
 * geo-DNS can steer each client to its own region. Swarm can't change a
 * service's mode in place, so the switch recreates the Caddy service — a
 * brief gap on 80/443, stated in the confirm.
 */
export function TopologyCard({ topology, haConfigured }: TopologyCardProps): React.JSX.Element {
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
        <div className="flex items-center gap-2">
          <Badge variant="default">{LABELS[topology]}</Badge>
        </div>
        {topology === 'edge-per-node' && !haConfigured ? (
          <p className="text-muted-foreground text-sm">
            Each edge node gets its own certificates. With geo-DNS, a certificate authority checking
            from several places can reach a different node than the one that asked, so a new
            domain's first certificate can fail. Turn on shared certificates (above) for one pool.
          </p>
        ) : null}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline" className="justify-self-start" disabled={setTopology.isPending}>
              {setTopology.isPending ? 'Switching…' : `Switch to ${LABELS[next].toLowerCase()}`}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Switch to {LABELS[next].toLowerCase()}?</AlertDialogTitle>
              <AlertDialogDescription>
                The Caddy service is removed and recreated, so sites and the dashboard's https
                address are unreachable for a few seconds while the new edge starts. Certificates
                already on a node are kept.
                {next === 'edge-per-node'
                  ? ' Caddy will run on every node marked as ingress.'
                  : ' Caddy will run on one node only.'}
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
      </CardContent>
    </Card>
  );
}
