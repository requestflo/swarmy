import * as React from 'react';
import type { NodeDetail } from '@swarmy/core';
import { Card, CardContent, cn } from '@swarmy/ui';

/**
 * Why a registered node isn't in the swarm (yet): the controller retries a
 * failed `swarm.join` with backoff, then gives up with "couldn't join the
 * cluster: <reason>". Hidden once the node is in the swarm or nothing failed.
 */
export function NodeSwarmJoinBanner({ node }: { node: NodeDetail | undefined }): React.JSX.Element | null {
  const o = node?.swarmOrchestration;
  if (!o || (o.state !== 'failed' && o.state !== 'joining')) return null;
  const gaveUp = o.detail.startsWith("couldn't join the cluster");
  const retrying = o.state === 'joining' || /retrying in/.test(o.detail);
  return (
    <Card className={cn('calm-card border-0', gaveUp ? 'bg-destructive/10' : 'bg-accent/40')}>
      <CardContent className="grid gap-1 py-4 text-sm">
        <p className="font-medium">
          {gaveUp ? "This node couldn't join the cluster" : retrying ? 'Joining the cluster…' : 'Joining the cluster failed'}
        </p>
        <p className="text-muted-foreground mono-data break-words text-xs">{o.detail}</p>
        {gaveUp && (
          <p className="text-muted-foreground text-xs">
            Check that the node can reach a manager on the mesh (TCP 2377, UDP 4789/7946), then restart its agent or run
            Repair — the controller tries again from the start.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
