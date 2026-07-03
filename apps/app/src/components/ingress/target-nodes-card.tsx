import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ServerIcon } from 'lucide-react';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Switch, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

interface TargetNodesCardProps {
  targetNodes: string[];
}

/**
 * Pin the ingress controller to specific nodes. A single pin wins outright
 * (`node.id==`); pinning several falls back to the `swarmy.node.ingress`
 * label tier (Swarm constraints AND, so a node-id list can't express "any of
 * these") — toggling here also flips that label via `nodes.setRole`.
 */
export function TargetNodesCard({ targetNodes }: TargetNodesCardProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const nodes = useQuery(trpc.nodes.list.queryOptions());
  const invalidate = (): void => void qc.invalidateQueries();

  const setTargetNodes = useMutation(
    trpc.ingress.setTargetNodes.mutationOptions({
      onSuccess: () => {
        toast.success('Target nodes updated — redeploy the controller to apply');
        invalidate();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const setRole = useMutation(
    trpc.nodes.setRole.mutationOptions({ onSuccess: invalidate, onError: (e) => toast.error(e.message) }),
  );

  const rows = nodes.data ?? [];
  const selected = new Set(targetNodes);

  const toggle = (id: string, ingress: boolean): void => {
    const next = ingress ? [...selected, id] : [...selected].filter((n) => n !== id);
    setTargetNodes.mutate({ nodeIds: next });
    setRole.mutate({ id, ingress });
  };

  return (
    <Card className="card-pop mt-6 border-0">
      <CardHeader>
        <CardTitle className="text-base">Target nodes</CardTitle>
        <CardDescription>
          Pick which nodes run the ingress controller. Pin one node directly, or mark several as the
          edge tier (<code className="mono-data">swarmy.node.ingress</code>).
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <div className="px-6 pb-8">
            <EmptyState icon={<ServerIcon />} title="No nodes yet" description="Add a node to pin ingress to it." className="border-0" />
          </div>
        ) : (
          <div className="divide-border divide-y border-t">
            {rows.map((n) => (
              <div key={n.id} className="flex items-center justify-between gap-4 px-6 py-3">
                <div className="min-w-0">
                  <p className="mono-data truncate text-sm font-medium">{n.name}</p>
                  <p className="text-muted-foreground mono-label truncate">{n.role}</p>
                </div>
                <Switch checked={selected.has(n.id)} onCheckedChange={(v) => toggle(n.id, v)} disabled={setTargetNodes.isPending} />
              </div>
            ))}
          </div>
        )}
      </CardContent>
      {targetNodes.length > 0 ? (
        <div className="flex justify-end px-6 pb-4">
          <Button variant="ghost" size="sm" onClick={() => setTargetNodes.mutate({ nodeIds: [] })} disabled={setTargetNodes.isPending}>
            Clear pin
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
