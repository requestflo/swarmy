import * as React from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useNodesState,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { ServiceNode } from './service-node';
import { ProjectGroupNode } from './project-group-node';
import { buildGraph, type CanvasNode, type ServiceNodeData } from './build-graph';
import { useCanvasLayout } from './use-canvas-layout';
import { CanvasToolbar } from './canvas-toolbar';
import { CanvasEmpty } from './canvas-empty';
import { ServiceDetailSheet } from './service-detail-sheet';

const NODE_TYPES = { service: ServiceNode, project: ProjectGroupNode };

function CanvasInner(): React.JSX.Element {
  const trpc = useTRPC();
  const inventory = useQuery({ ...trpc.inventory.get.queryOptions(), refetchInterval: 4_000 });
  const { isLoaded, positions, savedViewport, setPosition, setViewport } = useCanvasLayout();

  const [selected, setSelected] = React.useState<string | null>(null);
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<CanvasNode>([]);
  // Ids dragged this session keep their live position over a refetch, so a 4s poll
  // never snaps a card back to its saved/grid spot mid-arrange.
  const draggedRef = React.useRef<Set<string>>(new Set());

  const graph = React.useMemo(
    () => (inventory.data ? buildGraph(inventory.data, positions) : { nodes: [], edges: [] }),
    [inventory.data, positions],
  );

  React.useEffect(() => {
    if (!isLoaded) return;
    setFlowNodes((prev) => {
      const prevPos = new Map(prev.map((n) => [n.id, n.position]));
      return graph.nodes.map((n) =>
        n.type === 'service' && draggedRef.current.has(n.id) && prevPos.has(n.id)
          ? { ...n, position: prevPos.get(n.id)! }
          : n,
      );
    });
  }, [graph, isLoaded, setFlowNodes]);

  if (!inventory.isLoading && (inventory.data?.services.length ?? 0) === 0) return <CanvasEmpty />;

  return (
    <div className="h-[calc(100dvh-9.5rem)] w-full lg:h-[calc(100vh-6rem)]">
      <ReactFlow
        nodes={flowNodes}
        edges={graph.edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onNodeClick={(_e, node) => node.type === 'service' && setSelected(node.id)}
        onNodeDragStop={(_e, node) => {
          if (node.type !== 'service') return;
          draggedRef.current.add(node.id);
          setPosition(node.id, node.position.x, node.position.y);
        }}
        onMoveEnd={(_e, vp: Viewport) => setViewport(vp)}
        defaultViewport={savedViewport ?? undefined}
        fitView={!savedViewport}
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
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
            n.type === 'project'
              ? 'var(--border)'
              : `var(--status-${(n.data as ServiceNodeData)?.tone ?? 'idle'})`
          }
          nodeStrokeWidth={2}
          className="!rounded-xl"
        />
        <CanvasToolbar count={inventory.data?.services.length ?? 0} />
      </ReactFlow>
      <ServiceDetailSheet serviceId={selected} onOpenChange={(o) => !o && setSelected(null)} />
    </div>
  );
}

/**
 * The Applications plane: a Railway-style canvas of the live Docker inventory —
 * Project (stack) → Service → Container, with auto-inferred network/depends links.
 * Drag arranges services within their project (visual only, persisted).
 */
export function ApplicationsCanvas(): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}
