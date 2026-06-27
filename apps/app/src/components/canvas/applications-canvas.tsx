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
import { buildServiceNodes, type ServiceFlowNode, type ServiceNodeData } from './build-graph';
import { useCanvasLayout } from './use-canvas-layout';
import { CanvasToolbar } from './canvas-toolbar';
import { CanvasEmpty } from './canvas-empty';
import { ServiceDetailSheet } from './service-detail-sheet';

const NODE_TYPES = { service: ServiceNode };

function CanvasInner(): React.JSX.Element {
  const trpc = useTRPC();
  const services = useQuery({ ...trpc.services.list.queryOptions(), refetchInterval: 5_000 });
  const nodesQ = useQuery({ ...trpc.nodes.list.queryOptions(), refetchInterval: 5_000 });
  const stacksQ = useQuery(trpc.stacks.list.queryOptions());
  const { isLoaded, positions, savedViewport, setPosition, setViewport } = useCanvasLayout();

  const [stackFilter, setStackFilter] = React.useState('all');
  const [selected, setSelected] = React.useState<string | null>(null);
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<ServiceFlowNode>([]);
  // Ids the user has dragged this session — their live position wins over refetched
  // saved positions; every other node takes the latest server/grid position.
  const draggedRef = React.useRef<Set<string>>(new Set());

  const nodesById = React.useMemo(
    () => new Map((nodesQ.data ?? []).map((n) => [n.id, n])),
    [nodesQ.data],
  );
  const stackNameById = React.useMemo(
    () => new Map((stacksQ.data ?? []).map((s) => [s.id, s.name])),
    [stacksQ.data],
  );
  const filtered = React.useMemo(() => {
    const all = services.data ?? [];
    return stackFilter === 'all' ? all : all.filter((s) => s.stackId === stackFilter);
  }, [services.data, stackFilter]);

  // Rebuild nodes from live data, preserving any in-session drag positions so a
  // 5s refetch never snaps cards back to their saved/grid spot mid-arrange.
  React.useEffect(() => {
    if (!isLoaded) return;
    const fresh = buildServiceNodes(filtered, nodesById, stackNameById, positions);
    setFlowNodes((prev) => {
      const prevPos = new Map(prev.map((n) => [n.id, n.position]));
      return fresh.map((n) =>
        draggedRef.current.has(n.id) && prevPos.has(n.id)
          ? { ...n, position: prevPos.get(n.id)! }
          : n,
      );
    });
  }, [filtered, nodesById, stackNameById, positions, isLoaded, setFlowNodes]);

  if (!services.isLoading && (services.data?.length ?? 0) === 0) return <CanvasEmpty />;

  return (
    <div className="h-[calc(100dvh-9.5rem)] w-full lg:h-[calc(100vh-6rem)]">
      <ReactFlow
        nodes={flowNodes}
        edges={[]}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onNodeClick={(_e, node) => setSelected(node.id)}
        onNodeDragStop={(_e, node) => {
          draggedRef.current.add(node.id);
          setPosition(node.id, node.position.x, node.position.y);
        }}
        onMoveEnd={(_e, vp: Viewport) => setViewport(vp)}
        defaultViewport={savedViewport ?? undefined}
        fitView={!savedViewport}
        fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
        minZoom={0.2}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
        className="!bg-transparent"
      >
        <Background variant={BackgroundVariant.Dots} gap={28} size={1.5} color="var(--border)" />
        <Controls showInteractive={false} className="!shadow-lg" />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => `var(--status-${(n.data as ServiceNodeData)?.tone ?? 'idle'})`}
          className="!rounded-xl"
        />
        <CanvasToolbar
          count={filtered.length}
          stacks={(stacksQ.data ?? []).map((s) => ({ id: s.id, name: s.name }))}
          stackFilter={stackFilter}
          onStackFilter={setStackFilter}
        />
      </ReactFlow>
      <ServiceDetailSheet serviceId={selected} onOpenChange={(o) => !o && setSelected(null)} />
    </div>
  );
}

/** The Applications plane: a Railway-style canvas of services you can arrange freely. */
export function ApplicationsCanvas(): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}
