import { MarkerType, type Node as FlowNode } from '@xyflow/react';
import type { Inventory, InvService } from '@swarmy/core';
import { shortOf } from '@/components/connections/connections-model';
import type { CanvasEdge, CanvasNode, ServiceFlowNode } from './build-graph';
import type { DomainSpec, ServiceMetric } from './canvas-signals';
import type { DataNodeSpec } from './data-nodes';

export type DataFlowNode = FlowNode<{ spec: DataNodeSpec }, 'data'>;
export type DomainFlowNode = FlowNode<{ domain: DomainSpec }, 'domain'>;
export type AnyCanvasNode = CanvasNode | DataFlowNode | DomainFlowNode;

/** What the canvas draws beyond the inventory: data stores, the front door, live numbers. */
export interface CanvasExtras {
  stack: string;
  data: DataNodeSpec[];
  domain: DomainSpec | null;
  metrics: Map<string, ServiceMetric>;
}

const MANAGED = ['swarmy.db.cluster', 'swarmy.cache.cluster', 'swarmy.search.engine', 'swarmy.vector.name'];

/** A managed store's own service (a Postgres member, a cache sentinel…): its data node stands for it. */
export function isManagedMember(s: Pick<InvService, 'labels'>): boolean {
  return MANAGED.some((k) => !!s.labels[k]);
}

/** The inventory without managed-store members (once their data nodes are known). */
export function hideManagedMembers(inv: Inventory): Inventory {
  const services = inv.services.filter((s) => !isManagedMember(s));
  const keep = new Set(services.map((s) => s.id));
  return {
    projects: inv.projects.map((p) => ({ ...p, serviceIds: p.serviceIds.filter((id) => keep.has(id)) })),
    services,
    edges: inv.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
  };
}

const SERVICE_W = 248;
const DATA_H = 96;
const GAP_X = 88;
const GAP_Y = 20;
/** The front door sits above the parts it routes to, so the canvas stays narrow enough to read beside the aside. */
const DOOR_RISE = 150;

const LINK = { stroke: 'var(--muted-foreground)', strokeWidth: 1.5, opacity: 0.55 };

/**
 * Pure: the inventory graph plus a data node per store (to the right, linked
 * from each service wired to it), the front door (above, linked to the
 * services its addresses route to) and each part's live number.
 */
export function withExtras(graph: { nodes: CanvasNode[]; edges: CanvasEdge[] }, x: CanvasExtras): { nodes: AnyCanvasNode[]; edges: CanvasEdge[] } {
  const top = graph.nodes.filter((n): n is ServiceFlowNode => n.type === 'service' && !n.parentId);
  const byShort = new Map(graph.nodes.filter((n): n is ServiceFlowNode => n.type === 'service').map((n) => [shortOf(x.stack, n.data.service.name), n.id]));
  const xs = top.map((n) => n.position.x);
  const ys = top.map((n) => n.position.y);
  const minX = xs.length ? Math.min(...xs) : 0;
  const maxX = xs.length ? Math.max(...xs) : 0;
  const minY = ys.length ? Math.min(...ys) : 0;
  const maxY = ys.length ? Math.max(...ys) : 0;

  const nodes: AnyCanvasNode[] = graph.nodes.map((n) => {
    if (n.type !== 'service') return n;
    const metric = x.metrics.get(shortOf(x.stack, n.data.service.name));
    return metric ? { ...n, data: { ...n.data, metric } } : n;
  });
  const edges: CanvasEdge[] = [...graph.edges];

  const column = x.data.length * (DATA_H + GAP_Y) - GAP_Y;
  const startY = (minY + maxY) / 2 - column / 2 + 56;
  x.data.forEach((spec, i) => {
    nodes.push({ id: spec.id, type: 'data', position: { x: maxX + SERVICE_W + GAP_X, y: startY + i * (DATA_H + GAP_Y) }, data: { spec } });
    for (const short of spec.attached) {
      const source = byShort.get(short);
      if (!source) continue;
      edges.push({ id: `attach:${source}->${spec.id}`, source, target: spec.id, sourceHandle: 'r2', targetHandle: 'in', style: LINK, markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: 'var(--muted-foreground)' } });
    }
  });

  if (x.domain) {
    const targets = x.domain.targets.filter((id) => nodes.some((n) => n.id === id));
    const tx = targets.map((id) => nodes.find((n) => n.id === id)!.position.x);
    nodes.push({ id: 'domain', type: 'domain', position: { x: tx.length ? Math.min(...tx) : minX, y: minY - DOOR_RISE }, data: { domain: x.domain }, draggable: false });
    for (const t of targets) edges.push({ id: `door:${t}`, source: 'domain', target: t, sourceHandle: 'out', targetHandle: 'l1', style: LINK, animated: true });
  }
  return { nodes, edges };
}
