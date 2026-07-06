import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { NodeSummary } from '@swarmy/core';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState } from '@swarmy/ui';
import { ServerIcon } from 'lucide-react';
import { NodeRegionRow } from './node-region-row';

/**
 * Region + public IP per node — the two facts NS glue and geo-steering hang
 * off. Region is the `swarmy.region` label; the public IP is agent-detected
 * with an operator override (`swarmy.node.public-ip.override`) that wins.
 */
export function NodeRegionsCard({ nodes }: { nodes: NodeSummary[] }): React.JSX.Element {
  const qc = useQueryClient();
  const invalidate = (): void => void qc.invalidateQueries();

  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="text-base">Node regions & public IPs</CardTitle>
        <CardDescription>
          Region is the <code className="mono-data">swarmy.region</code> label — pushed to the
          Swarm engine so placement constraints work even without swarmy. The public IP becomes DNS
          answers and registrar glue; override it when detection is wrong (NAT, proxies).
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
              <NodeRegionRow key={n.id} node={n} onChange={invalidate} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
