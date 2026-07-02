import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Background,
  BackgroundVariant,
  MarkerType,
  ReactFlow,
  type Edge as FlowEdge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { WaypointsIcon } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Skeleton,
} from '@swarmy/ui';
import type { ServiceMapView } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { ServiceMapNode, type ServiceMapFlowNode } from './service-map-node';
import { layoutServiceMap } from './service-map-layout';

const NODE_TYPES = { svcmap: ServiceMapNode };
const WINDOW_MINUTES = 15;

/** Project the map view into React Flow nodes + labelled edges. */
function toFlow(map: ServiceMapView): { nodes: ServiceMapFlowNode[]; edges: FlowEdge[] } {
  const positions = layoutServiceMap(map.nodes, map.edges);
  const degraded = new Set(map.nodes.filter((n) => n.degraded).map((n) => n.id));
  const nodes: ServiceMapFlowNode[] = map.nodes.map((n) => ({
    id: n.id,
    type: 'svcmap',
    position: positions.get(n.id) ?? { x: 0, y: 0 },
    data: { node: n },
    draggable: false,
  }));
  const edges: FlowEdge[] = map.edges.map((e) => {
    const warn = degraded.has(e.to);
    const stroke = warn ? 'var(--status-warning)' : 'var(--status-progress)';
    return {
      id: `${e.from}->${e.to}`,
      source: e.from,
      target: e.to,
      animated: warn,
      label: `${e.callsPerMin}/min · ${(e.errorRate * 100).toFixed(1)}% · p95 ${Math.round(e.p95Ms)}ms`,
      style: { stroke, strokeWidth: 1.75, opacity: 0.9 },
      labelStyle: { fontSize: 10, fill: 'var(--muted-foreground)' },
      labelBgStyle: { fill: 'var(--card)', fillOpacity: 0.9 },
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: stroke },
    };
  });
  return { nodes, edges };
}

/**
 * The live service map: who calls whom, how often, how slowly, and where the
 * errors are — derived from client/server span pairs in the trace store.
 */
export function ServiceMapPanel({ enabled }: { enabled: boolean }): React.JSX.Element {
  const trpc = useTRPC();
  const map = useQuery({
    ...trpc.observability.map.queryOptions({ windowMinutes: WINDOW_MINUTES }),
    enabled,
    refetchInterval: enabled ? 15_000 : false,
  });

  const flow = React.useMemo(
    () => (map.data?.status === 'ok' ? toFlow(map.data) : { nodes: [], edges: [] }),
    [map.data],
  );

  const teach = (
    <EmptyState
      className="m-6"
      icon={<WaypointsIcon />}
      title={enabled ? 'No service calls seen yet' : 'Observability is off'}
      description={
        enabled
          ? 'Turn on telemetry for a stack and send it some traffic — the call graph draws itself from the traces.'
          : 'Turn on observability above, then enable telemetry per stack — the map appears as soon as traces flow.'
      }
      action={
        <Button asChild variant="outline" size="sm">
          <Link to="/stacks">Open stacks</Link>
        </Button>
      }
    />
  );

  return (
    <Card className="card-pop mb-4 border-0">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <WaypointsIcon className="size-4" /> Service map
        </CardTitle>
        <CardDescription>
          Calls between your services over the last {WINDOW_MINUTES} minutes — rate, error share and
          p95 per edge. Degraded services glow amber.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {!enabled || map.data?.status === 'disabled' ? (
          teach
        ) : map.isLoading ? (
          <Skeleton className="m-6 h-[360px] rounded-2xl" />
        ) : map.isError ? (
          <EmptyState
            className="m-6"
            icon={<WaypointsIcon />}
            title="Couldn't load the map"
            description={map.error.message}
            action={
              <Button variant="outline" size="sm" onClick={() => void map.refetch()}>
                Retry
              </Button>
            }
          />
        ) : map.data?.status === 'unreachable' ? (
          <EmptyState
            className="m-6"
            icon={<WaypointsIcon />}
            title="Store unreachable"
            description="The collector is up but ClickHouse isn't answering yet. Give it a moment after first deploy."
          />
        ) : flow.nodes.length === 0 ? (
          teach
        ) : (
          <div className="h-[400px] w-full rounded-b-2xl">
            <ReactFlow
              nodes={flow.nodes}
              edges={flow.edges}
              nodeTypes={NODE_TYPES}
              fitView
              fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
              nodesConnectable={false}
              elementsSelectable={false}
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1.25} />
            </ReactFlow>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
