import * as React from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useNodesState,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useQuery } from '@tanstack/react-query';
import type { Inventory } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { ServiceNode } from './service-node';
import { ProjectGroupNode } from './project-group-node';
import { buildGraph, type CanvasNode, type ServiceNodeData } from './build-graph';
import { filterInventory } from './filter-inventory';
import { useCanvasLayout } from './use-canvas-layout';
import { CanvasToolbar } from './canvas-toolbar';
import { CanvasBreadcrumb } from './canvas-breadcrumb';
import { ServiceDetailSheet } from './service-detail-sheet';

const NODE_TYPES = { service: ServiceNode, project: ProjectGroupNode };

interface ServiceCanvasProps {
  /** Stack name to scope the canvas to, or null for the flat cross-swarm view. */
  stackFilter: string | null;
  onBack: () => void;
}

/**
 * The service-level canvas: the live Docker inventory as a React Flow graph —
 * Project (stack) → Service → Container with inferred network/depends links.
 * Scoped to one stack (drill-in) or the whole swarm ("All services"). Drag
 * arranges services within their frame (visual only, persisted per-org via
 * canvas.get/save). Mounted under a keyed ReactFlowProvider so switching scope
 * re-fits cleanly.
 */
export function ServiceCanvas({ stackFilter, onBack }: ServiceCanvasProps): React.JSX.Element {
  const trpc = useTRPC();
  const inventory = useQuery({ ...trpc.inventory.get.queryOptions(), refetchInterval: 4_000 });
  const { isLoaded, positions, savedViewport, setPosition, setViewport } = useCanvasLayout();

  const [selected, setSelected] = React.useState<string | null>(null);
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<CanvasNode>([]);
  // Ids dragged this session keep their live position over a refetch, so a 4s poll
  // never snaps a card back to its saved/grid spot mid-arrange.
  const draggedRef = React.useRef<Set<string>>(new Set());

  const scoped: Inventory | null = React.useMemo(
    () => (inventory.data ? filterInventory(inventory.data, stackFilter) : null),
    [inventory.data, stackFilter],
  );

  const graph = React.useMemo(
    () => (scoped ? buildGraph(scoped, positions) : { nodes: [], edges: [] }),
    [scoped, positions],
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

  // Viewport (camera) is only persisted for the flat "All services" view — the
  // store holds one viewport per org, so a drilled-in stack just fit-views
  // instead of clobbering it. Drag positions persist in every view.
  const isAll = stackFilter === null;

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
        onMoveEnd={(_e, vp: Viewport) => isAll && setViewport(vp)}
        defaultViewport={isAll ? (savedViewport ?? undefined) : undefined}
        fitView={!isAll || !savedViewport}
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
        <CanvasBreadcrumb stack={stackFilter} onBack={onBack} />
        <CanvasToolbar count={scoped?.services.length ?? 0} />
      </ReactFlow>
      <ServiceDetailSheet serviceId={selected} onOpenChange={(o) => !o && setSelected(null)} />
    </div>
  );
}
