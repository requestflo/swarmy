import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { TrafficNowView } from '@swarmy/core';
import { CodeView } from '@/components/calm';
import { nodesRest, stacksRest } from '@/components/apps/estate-code';
import { useTRPC } from '@/integrations/trpc';

/** The dashboard queries behind the map that have no public REST route (tRPC). */
export function mapDashboardQueries(now: TrafficNowView | undefined): string {
  const regions = (now?.regions ?? []).map((r) => ({ region: r.region, requestsPerMin: r.requestsPerMin, state: r.state }));
  return [
    '# the flows and visits a minute are a dashboard query (tRPC, not public REST)',
    'traffic.now',
    JSON.stringify({ totals: now?.totals ?? null, regions }, null, 2),
    '',
    '# where each region sits, the private network and prices',
    'geodns.listRegions',
    'mesh.listPeers',
    'cost.overview',
    '',
    '# the needs-you sparkline and Rewind',
    'traffic.series { "app": "<app>", "window": "6h" }',
    'releases.list { "limit": 100 } · backups.listSnapshots {} · incidents.list { "limit": 50 }',
  ].join('\n');
}

/** The Map as code: the real REST calls for servers and apps, plus the dashboard queries. */
export function EstateMapCode({ traffic }: { traffic: TrafficNowView | undefined }): React.JSX.Element {
  const trpc = useTRPC();
  const nodes = useQuery(trpc.nodes.list.queryOptions());
  const stacks = useQuery(trpc.stacks.list.queryOptions());
  return (
    <CodeView
      tabs={[
        { label: 'GET /nodes', code: nodesRest(nodes.data ?? []) },
        { label: 'GET /stacks', code: stacksRest(stacks.data ?? []) },
        { label: 'dashboard query', code: mapDashboardQueries(traffic) },
      ]}
      source="readonly"
    />
  );
}
