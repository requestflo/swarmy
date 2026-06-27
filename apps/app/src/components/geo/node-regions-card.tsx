import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  toast,
} from '@swarmy/ui';
import { ServerIcon } from 'lucide-react';
import { useTRPC } from '@/integrations/trpc';

interface GeoNode {
  id: string;
  name: string;
  hostname: string;
}

interface NodeRegionsCardProps {
  nodes: GeoNode[];
  /** Invalidate queries after a mutation (mirrors the page invalidate). */
  onChange: () => void;
}

/** Assign each node a `swarmy.region` label — flat rows in one card-pop. */
export function NodeRegionsCard({ nodes, onChange }: NodeRegionsCardProps): React.JSX.Element {
  const trpc = useTRPC();

  const setNodeRegion = useMutation(
    trpc.geodns.setNodeRegion.mutationOptions({
      onSuccess: () => {
        toast.success('Region assigned');
        onChange();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Card className="card-pop mt-6 border-0">
      <CardHeader>
        <CardTitle className="text-base">Node regions</CardTitle>
        <CardDescription>
          Region is the <code className="mono-data">swarmy.region</code> label — pushed to the Swarm
          engine so placement constraints work even without swarmy.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {nodes.length === 0 ? (
          <div className="px-6 pb-8">
            <EmptyState
              icon={<ServerIcon />}
              title="No nodes yet"
              description="Add a node, then give it a region so Geo-DNS knows where its ingress lives."
              className="border-0"
            />
          </div>
        ) : (
          <div className="divide-border divide-y border-t">
            {nodes.map((n) => (
              <NodeRegionRow
                key={n.id}
                node={n}
                pending={setNodeRegion.isPending}
                onSet={(region) => setNodeRegion.mutate({ nodeId: n.id, region })}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function NodeRegionRow({
  node,
  pending,
  onSet,
}: {
  node: GeoNode;
  pending: boolean;
  onSet: (region: string) => void;
}): React.JSX.Element {
  const [region, setRegion] = React.useState('');
  return (
    <div className="hover:bg-accent/60 flex items-center gap-3 px-6 py-4 transition-colors">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{node.name}</p>
        <p className="text-muted-foreground mono-label truncate">{node.hostname}</p>
      </div>
      <Input
        value={region}
        onChange={(e) => setRegion(e.target.value)}
        placeholder="us-east"
        className="max-w-40"
      />
      <Button variant="outline" size="sm" onClick={() => onSet(region)} disabled={!region || pending}>
        Set region
      </Button>
    </div>
  );
}
