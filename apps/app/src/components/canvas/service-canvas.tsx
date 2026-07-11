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
import { useNavigate } from '@tanstack/react-router';
import { useQuery, useMutation } from '@tanstack/react-query';
import type { Inventory } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { ServiceNode } from './service-node';
import { ProjectGroupNode } from './project-group-node';
import { DbClusterNode } from './db-cluster-node';
import { buildGraph, type CanvasNode, type ServiceNodeData } from './build-graph';
import { filterInventory } from './filter-inventory';
import { useCanvasLayout } from './use-canvas-layout';
import { CanvasToolbar } from './canvas-toolbar';
import { CanvasBreadcrumb } from './canvas-breadcrumb';

const NODE_TYPES = { service: ServiceNode, project: ProjectGroupNode, dbCluster: DbClusterNode };

interface ServiceCanvasProps {
  /** Stack name to scope the canvas to, or null for the flat cross-swarm view. */
  stackFilter: string | null;
  onBack: () => void;
  /**
   * Tap a service card → transport into it. Receives the tap's screen
   * position so the overlay can zoom out of the node itself.
   */
  onOpenService: (id: string, origin: { x: number; y: number }) => void;
}

/**
 * The service-level canvas: the live Docker inventory as a React Flow graph —
 * Project (stack) → Service → Container with inferred network/depends links.
 * Scoped to one stack (drill-in) or the whole swarm ("All services"). Drag
 * arranges services within their frame (visual only, persisted per-org via
 * canvas.get/save). Tapping a card transports you into it: a service card
 * opens the zoom-in service overlay, a db-cluster frame the stack's Data tab.
 * Fills whatever height its parent gives it (`h-full`) — the route layout owns
 * viewport fit. Mounted under a keyed ReactFlowProvider so switching scope
 * re-fits cleanly.
 */
export function ServiceCanvas({ stackFilter, onBack, onOpenService }: ServiceCanvasProps): React.JSX.Element {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const inventory = useQuery({ ...trpc.inventory.get.queryOptions(), refetchInterval: 4_000 });
  const { savedViewport, setViewport } = useCanvasLayout();
  // Canvas position is Docker-truth: persisted as swarmy.canvas.x/y labels on the service.
  const setCanvasPos = useMutation(trpc.services.setCanvasPos.mutationOptions());

  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<CanvasNode>([]);
  // Ids dragged this session keep their live position over a refetch, so a 4s poll
  // never snaps a card back to its saved/grid spot mid-arrange.
  const draggedRef = React.useRef<Set<string>>(new Set());

  const scoped: Inventory | null = React.useMemo(
    () => (inventory.data ? filterInventory(inventory.data, stackFilter) : null),
    [inventory.data, stackFilter],
  );

  const graph = React.useMemo(
    () => (scoped ? buildGraph(scoped) : { nodes: [], edges: [] }),
    [scoped],
  );

  React.useEffect(() => {
    if (!scoped) return;
    setFlowNodes((prev) => {
      const prevPos = new Map(prev.map((n) => [n.id, n.position]));
      return graph.nodes.map((n) =>
        n.type === 'service' && draggedRef.current.has(n.id) && prevPos.has(n.id)
          ? { ...n, position: prevPos.get(n.id)! }
          : n,
      );
    });
  }, [graph, scoped, setFlowNodes]);

  const onNodeClick = React.useCallback(
    (event: React.MouseEvent, node: CanvasNode): void => {
      if (node.type === 'service') {
        onOpenService(node.id, { x: event.clientX, y: event.clientY });
      } else if (node.type === 'dbCluster') {
        void navigate({ to: '/stacks/$name/data', params: { name: node.data.stack }, viewTransition: true });
      }
      // Project frames are backdrops — clicking them does nothing.
    },
    [navigate, onOpenService],
  );

  // Viewport (camera) is only persisted for the flat "All services" view — the
  // store holds one viewport per org, so a drilled-in stack just fit-views
  // instead of clobbering it. Drag positions persist in every view.
  const isAll = stackFilter === null;

  return (
    <div className="relative h-full min-h-0 w-full min-w-0">
      <ReactFlow
        nodes={flowNodes}
        edges={graph.edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onNodeClick={(e, node) => onNodeClick(e, node as CanvasNode)}
        // A micro-movement is a tap, not an arrange — keeps taps reliable on touch.
        nodeDragThreshold={8}
        onNodeDragStop={(_e, node) => {
          if (node.type !== 'service') return;
          draggedRef.current.add(node.id);
          setCanvasPos.mutate({ id: node.id, x: node.position.x, y: node.position.y });
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
        <CanvasToolbar count={scoped?.services.length ?? 0} stack={stackFilter} />
      </ReactFlow>
    </div>
  );
}
