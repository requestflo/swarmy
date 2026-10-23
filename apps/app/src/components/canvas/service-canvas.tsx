import * as React from 'react';
import { ReactFlow, Background, BackgroundVariant, Controls, MiniMap } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useQuery, useMutation } from '@tanstack/react-query';
import type { Inventory } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { ServiceNode } from './service-node';
import { ProjectGroupNode } from './project-group-node';
import { DbClusterNode } from './db-cluster-node';
import { DataNode } from './data-node';
import { DomainNode } from './domain-node';
import type { ServiceNodeData } from './build-graph';
import type { AnyCanvasNode, CanvasExtras } from './canvas-extras';
import { filterInventory } from './filter-inventory';
import { CanvasToolbar } from './canvas-toolbar';
import { useConnectMode } from './connect/connect-context';
import { useCanvasGraph } from './use-canvas-graph';
import { useDepth } from '@/components/calm';
import { ErrorState } from '@/components/states';

const NODE_TYPES = { service: ServiceNode, project: ProjectGroupNode, dbCluster: DbClusterNode, data: DataNode, domain: DomainNode };
const DROPPABLE = new Set(['service', 'data']);

interface ServiceCanvasProps {
  /** The app (stack) the canvas shows. */
  stackFilter: string;
  /** A node was tapped (in connect mode too — the frame decides what that means). */
  onNodeTap: (node: AnyCanvasNode) => void;
  /** Data stores, front door and per-part numbers (null while unknown). */
  extras: CanvasExtras | null;
  /** A drag from a part landed on a target (connect mode). */
  onConnectDrag?: (from: string, to: string) => void;
  /** A drag began from a part's connect handle. */
  onConnectStart?: (from: string) => void;
  /** Scale the canvas chrome down (the app page's "How it is built" frame). */
  embedded?: boolean;
  /** The part whose sheet is open (URL state) — drawn selected. */
  selectedId?: string;
  /** Extra panels drawn inside the flow (the tool row). */
  children?: React.ReactNode;
}

/**
 * The app canvas (board AppCanvas): the live Docker inventory as a React Flow
 * graph — the app's parts, its managed stores and its front door, with each
 * part's live number. Drag arranges parts (persisted as swarmy.canvas.x/y
 * labels); in connect mode a drag from a part's dot to a store or part asks
 * to connect them. Fills its parent's height; mounted under a keyed
 * ReactFlowProvider so switching apps re-fits cleanly.
 */
export function ServiceCanvas({ stackFilter, onNodeTap, extras, onConnectDrag, onConnectStart, embedded, selectedId, children }: ServiceCanvasProps): React.JSX.Element {
  const trpc = useTRPC();
  const inventory = useQuery({ ...trpc.inventory.get.queryOptions(), refetchInterval: 4_000 });
  const setCanvasPos = useMutation(trpc.services.setCanvasPos.mutationOptions());
  const controls = useDepth().atLeast('controls');
  const connect = useConnectMode();
  const scoped: Inventory | null = React.useMemo(() => (inventory.data ? filterInventory(inventory.data, stackFilter) : null), [inventory.data, stackFilter]);
  const g = useCanvasGraph(scoped, extras, embedded);
  const types = React.useMemo(() => new Map(g.nodes.map((n) => [n.id, n.type])), [g.nodes]);

  if (!scoped) {
    return (
      <div className="h-full min-h-0 w-full min-w-0">
        {inventory.isError ? (
          <ErrorState className="h-full" title="Couldn’t read the swarm’s inventory." error={inventory.error} retry={() => void inventory.refetch()} retrying={inventory.isFetching} />
        ) : (
          <div className="shimmer-line h-full w-full rounded-3xl" role="status" aria-label="Loading canvas" />
        )}
      </div>
    );
  }

  return (
    <div className="relative h-full min-h-0 w-full min-w-0">
      <ReactFlow
        nodes={selectedId === undefined ? g.nodes : g.nodes.map((n) => (n.selected === (n.id === selectedId) ? n : { ...n, selected: n.id === selectedId }))}
        edges={g.edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={g.onNodesChange}
        onNodeClick={(_e, node) => onNodeTap(node as AnyCanvasNode)}
        // A micro-movement is a tap, not an arrange — keeps taps reliable on touch.
        nodeDragThreshold={8}
        onNodeDragStop={(_e, node) => {
          g.dragged.current.add(node.id);
          if (node.type === 'service') setCanvasPos.mutate({ id: node.id, x: node.position.x, y: node.position.y });
        }}
        fitView
        fitViewOptions={{ padding: 0.08, maxZoom: 1, minZoom: embedded ? 0.5 : undefined }}
        minZoom={0.2}
        maxZoom={1.6}
        nodesConnectable={connect.on}
        onConnectStart={(_e, p) => p.nodeId && onConnectStart?.(p.nodeId)}
        onConnect={(c) => onConnectDrag?.(c.source, c.target)}
        isValidConnection={(c) => c.source !== c.target && types.get(c.source) === 'service' && DROPPABLE.has(types.get(c.target) ?? '')}
        connectionLineStyle={{ stroke: 'var(--primary)', strokeWidth: 2, strokeDasharray: '5 5' }}
        proOptions={{ hideAttribution: true }}
        className="!bg-transparent"
      >
        <Background variant={BackgroundVariant.Dots} gap={28} size={1.5} color="var(--border)" />
        {/* Quiet chrome: zoom + minimap only from Controls up (Harbour: less on screen). */}
        {controls ? <Controls showInteractive={false} className="!shadow-none" /> : null}
        {controls && !embedded ? (
          <MiniMap
            pannable
            zoomable
            nodeColor={(n) => (n.type === 'service' ? `var(--status-${(n.data as ServiceNodeData)?.tone ?? 'idle'})` : 'var(--border)')}
            nodeStrokeWidth={2}
            className="!rounded-xl max-lg:!hidden"
          />
        ) : null}
        <CanvasToolbar count={g.nodes.filter((n) => n.type === 'service').length} stack={stackFilter} />
        {children}
      </ReactFlow>
    </div>
  );
}
