import { MarkerType, type Edge as FlowEdge } from '@xyflow/react';
import type { ServiceMapView } from '@swarmy/core';
import type { ServiceMapFlowNode } from './service-map-node';
import { layoutServiceMap } from './service-map-layout';

/** Project the map view into React Flow nodes + labelled edges. */
export function toFlow(map: ServiceMapView): { nodes: ServiceMapFlowNode[]; edges: FlowEdge[] } {
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
 * Scope the estate-wide map to one stack: keep the stack's own services plus
 * their direct neighbours (an edge with at least one endpoint inside), so
 * cross-stack calls stay visible as context. The `observability.map` procedure
 * is estate-wide by design — scoping is a client-side projection over live
 * inventory names.
 */
export function scopeMapToStack(
  map: ServiceMapView,
  has: (serviceName: string) => boolean,
): ServiceMapView {
  const inStack = new Set(map.nodes.filter((n) => has(n.id)).map((n) => n.id));
  if (inStack.size === 0) return { ...map, nodes: [], edges: [] };
  const edges = map.edges.filter((e) => inStack.has(e.from) || inStack.has(e.to));
  const keep = new Set(inStack);
  for (const e of edges) {
    keep.add(e.from);
    keep.add(e.to);
  }
  return { ...map, nodes: map.nodes.filter((n) => keep.has(n.id)), edges };
}
