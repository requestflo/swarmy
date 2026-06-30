import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  useNodesState,
  type Node as FlowNode,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useQuery, useMutation } from '@tanstack/react-query';
import { ServerIcon } from 'lucide-react';
import { Button, EmptyState } from '@swarmy/ui';
import { NODE_STATUS_TONE, type NodeSummary } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { InfraNode } from './infra-node';

/** Flow-node data for the Infrastructure canvas — one live node per card. */
export interface InfraNodeData extends Record<string, unknown> {
  node: NodeSummary;
}
export type InfraFlowNode = FlowNode<InfraNodeData, 'infra'>;

type Positions = Record<string, { x: number; y: number }>;

const NODE_TYPES = { infra: InfraNode };

// Flat grid geometry for nodes that don't yet have a saved canvas position.
const NODE_W = 288;
const NODE_H = 212;
const COL_GAP = 36;
const ROW_GAP = 36;
const PER_ROW = 4;

function gridFallback(i: number): { x: number; y: number } {
  const col = i % PER_ROW;
  const row = Math.floor(i / PER_ROW);
  return { x: col * (NODE_W + COL_GAP), y: row * (NODE_H + ROW_GAP) };
}

/** Project the live node list into flow nodes; saved position (Docker labels) wins, else auto-grid. */
function buildNodeFlow(nodes: NodeSummary[], positions: Positions): InfraFlowNode[] {
  return nodes.map((node, i) => ({
    id: node.id,
    type: 'infra',
    position: positions[node.id] ?? gridFallback(i),
    data: { node },
  }));
}

/** Status dot/minimap colour token for a node (neutral maps to the idle token). */
function nodeToneToken(status: string): string {
  const tone = NODE_STATUS_TONE[status] ?? 'neutral';
  return tone === 'neutral' ? 'idle' : tone;
}

function InfraCanvasInner(): React.JSX.Element {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const nodes = useQuery({ ...trpc.nodes.list.queryOptions(), refetchInterval: 5_000 });
  // Canvas position is Docker-truth: persisted as swarmy.canvas.x/y node labels.
  const positions = useQuery(trpc.nodes.canvasPositions.queryOptions());
  const setCanvasPos = useMutation(trpc.nodes.setCanvasPosition.mutationOptions());

  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<InfraFlowNode>([]);
  // Ids dragged this session keep their live position over a refetch, so the 5s
  // poll never snaps a card back to its saved/grid spot mid-arrange.
  const draggedRef = React.useRef<Set<string>>(new Set());

  const graph = React.useMemo(
    () => buildNodeFlow(nodes.data ?? [], positions.data ?? {}),
    [nodes.data, positions.data],
  );

  React.useEffect(() => {
    setFlowNodes((prev) => {
      const prevPos = new Map(prev.map((n) => [n.id, n.position]));
      return graph.map((n) =>
        draggedRef.current.has(n.id) && prevPos.has(n.id)
          ? { ...n, position: prevPos.get(n.id)! }
          : n,
      );
    });
  }, [graph, setFlowNodes]);

  const total = nodes.data?.length ?? 0;

  if (total === 0 && !nodes.isLoading) {
    return (
      <div className="border-border/60 bg-card/30 flex h-[clamp(420px,56vh,720px)] w-full items-center justify-center rounded-3xl border">
        <EmptyState
          className="border-0 bg-transparent"
          icon={<ServerIcon className="size-6" />}
          title="No nodes yet"
          description="Add your first node and it'll appear on the canvas within seconds of the agent connecting."
          action={
            <Button onClick={() => navigate({ to: '/nodes/new' })}>
              <ServerIcon className="size-4" /> Add a node
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="border-border/60 h-[clamp(520px,68vh,860px)] w-full overflow-hidden rounded-3xl border">
      <ReactFlow
        nodes={flowNodes}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onNodeClick={(_e, node) => navigate({ to: '/nodes/$nodeId', params: { nodeId: node.id } })}
        onNodeDragStop={(_e, node) => {
          draggedRef.current.add(node.id);
          setCanvasPos.mutate({ id: node.id, x: node.position.x, y: node.position.y });
        }}
        fitView
        fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
        minZoom={0.2}
        maxZoom={1.6}
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
        className="!bg-transparent"
      >
        <Background variant={BackgroundVariant.Dots} gap={28} size={1.5} color="var(--border)" />
        <Controls showInteractive={false} className="!shadow-lg" />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) =>
            `var(--status-${nodeToneToken((n.data as InfraNodeData)?.node?.status ?? '')})`
          }
          nodeStrokeWidth={2}
          className="!rounded-xl"
        />
        <Panel position="top-right" className="!m-3">
          <span className="card-pop mono-data text-muted-foreground rounded-full px-3 py-2 text-xs">
            {total} {total === 1 ? 'node' : 'nodes'}
          </span>
        </Panel>
      </ReactFlow>
    </div>
  );
}

/**
 * The Infrastructure canvas: the live swarm as a React Flow graph of draggable
 * node cards (mirrors the service/Stacks canvas). Drag arranges the topology
 * (persisted per-node as swarmy.canvas.x/y Docker labels); clicking a card opens
 * the node detail. Wrapped in its own ReactFlowProvider so it mounts cleanly
 * alongside the Applications canvas.
 */
export function InfraCanvas(): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <InfraCanvasInner />
    </ReactFlowProvider>
  );
}
