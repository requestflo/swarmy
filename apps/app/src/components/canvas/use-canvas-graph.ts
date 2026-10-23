import * as React from 'react';
import { useNodesState, useReactFlow } from '@xyflow/react';
import type { Inventory } from '@swarmy/core';
import { buildGraph, type CanvasEdge } from './build-graph';
import { hideManagedMembers, withExtras, type AnyCanvasNode, type CanvasExtras } from './canvas-extras';

/**
 * The canvas's nodes: the scoped inventory (managed-store members folded into
 * their data node once the stores are known), plus the extras. Ids dragged
 * this session keep their live position over a refetch, so a poll never snaps
 * a card back mid-arrange; the view re-fits when the set of nodes changes.
 */
export function useCanvasGraph(scoped: Inventory | null, extras: CanvasExtras | null, embedded?: boolean) {
  const { fitView } = useReactFlow();
  const graph = React.useMemo((): { nodes: AnyCanvasNode[]; edges: CanvasEdge[] } => {
    if (!scoped) return { nodes: [], edges: [] };
    return extras ? withExtras(buildGraph(hideManagedMembers(scoped), {}), extras) : buildGraph(scoped, {});
  }, [scoped, extras]);

  const [nodes, setNodes, onNodesChange] = useNodesState<AnyCanvasNode>([]);
  const dragged = React.useRef<Set<string>>(new Set());

  React.useEffect(() => {
    if (!scoped) return;
    setNodes((prev) => {
      const prevPos = new Map(prev.map((n) => [n.id, n.position]));
      return graph.nodes.map((n) => (dragged.current.has(n.id) && prevPos.has(n.id) ? { ...n, position: prevPos.get(n.id)! } : n));
    });
  }, [graph, scoped, setNodes]);

  const shape = graph.nodes.map((n) => n.id).join('|');
  React.useEffect(() => {
    if (!shape) return;
    const t = window.setTimeout(() => void fitView({ padding: 0.08, maxZoom: 1, minZoom: embedded ? 0.5 : undefined, duration: 250 }), 60);
    return () => window.clearTimeout(t);
  }, [shape, fitView, embedded]);

  return { nodes, edges: graph.edges, onNodesChange, dragged };
}
