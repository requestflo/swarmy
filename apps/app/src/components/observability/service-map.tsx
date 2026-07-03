import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Background, BackgroundVariant, ReactFlow } from '@xyflow/react';
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
import { useTRPC } from '@/integrations/trpc';
import { ServiceMapNode } from './service-map-node';
import { scopeMapToStack, toFlow } from './service-map-flow';
import { useStackServiceNames } from './use-stack-services';

const NODE_TYPES = { svcmap: ServiceMapNode };
const WINDOW_MINUTES = 15;

interface ServiceMapPanelProps {
  enabled: boolean;
  /** Scope the graph to one stack's services (plus their direct neighbours). */
  stack?: string;
}

/**
 * The live service map: who calls whom, how often, how slowly, and where the
 * errors are — derived from client/server span pairs in the trace store.
 */
export function ServiceMapPanel({ enabled, stack }: ServiceMapPanelProps): React.JSX.Element {
  const trpc = useTRPC();
  const map = useQuery({
    ...trpc.observability.map.queryOptions({ windowMinutes: WINDOW_MINUTES }),
    enabled,
    refetchInterval: enabled ? 15_000 : false,
  });
  const stackNames = useStackServiceNames(stack);

  const flow = React.useMemo(() => {
    if (map.data?.status !== 'ok') return { nodes: [], edges: [] };
    return toFlow(stack ? scopeMapToStack(map.data, stackNames.has) : map.data);
  }, [map.data, stack, stackNames.has]);

  const teach = (
    <EmptyState
      className="m-6"
      icon={<WaypointsIcon />}
      title={enabled ? 'No service calls seen yet' : 'Observability is off'}
      description={
        enabled
          ? `Turn on telemetry ${stack ? `for ${stack}` : 'for a stack'} and send it some traffic — the call graph draws itself from the traces.`
          : 'Turn on observability above, then enable telemetry per stack — the map appears as soon as traces flow.'
      }
      action={
        stack ? undefined : (
          <Button asChild variant="outline" size="sm">
            <Link to="/stacks">Open stacks</Link>
          </Button>
        )
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
          Calls between {stack ? `${stack}'s services` : 'your services'} over the last{' '}
          {WINDOW_MINUTES} minutes — rate, error share and p95 per edge. Degraded services glow
          amber.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {!enabled || map.data?.status === 'disabled' ? (
          teach
        ) : map.isLoading || stackNames.isLoading ? (
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
