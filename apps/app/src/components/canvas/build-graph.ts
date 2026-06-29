import { type Edge as FlowEdge, type Node as FlowNode, MarkerType } from '@xyflow/react';
import type { Inventory, InvEdge, InvService } from '@swarmy/core';
import { STATUS_TONE } from './stack-aggregates';

export interface ServiceNodeData extends Record<string, unknown> {
  service: InvService;
  /** Status token name (online | warning | progress | offline | idle). */
  tone: string;
}
export interface ProjectNodeData extends Record<string, unknown> {
  /** Display label ("Ungrouped" for the catch-all project). */
  label: string;
  ungrouped: boolean;
  count: number;
  /** Aggregate status token for the project dot. */
  tone: string;
}

export type ServiceFlowNode = FlowNode<ServiceNodeData, 'service'>;
export type ProjectFlowNode = FlowNode<ProjectNodeData, 'project'>;
export type CanvasNode = ServiceFlowNode | ProjectFlowNode;
export type CanvasEdge = FlowEdge;

export type Positions = Record<string, { x: number; y: number }>;

/** Per-service canvas position is Docker-truth — stored as labels on the service. */
export const CANVAS_X_LABEL = 'swarmy.canvas.x';
export const CANVAS_Y_LABEL = 'swarmy.canvas.y';

// Flat layout geometry — services flow across the full canvas, no group frame.
const SERVICE_W = 248;
const SERVICE_H = 178;
const COL_GAP = 40;
const ROW_GAP = 40;
const PER_ROW = 4;

/** Network links have no on-brand teal token — this soft teal matches the token space. */
const NETWORK_TEAL = 'oklch(0.72 0.1 195)';

// STATUS_TONE + aggregateTone are shared with the stack-overview cards so the
// per-stack worst-of dot matches in both views (see ./stack-aggregates).

function serviceFallback(index: number): { x: number; y: number } {
  const col = index % PER_ROW;
  const row = Math.floor(index / PER_ROW);
  return { x: col * (SERVICE_W + COL_GAP), y: row * (SERVICE_H + ROW_GAP) };
}

/** Read a service's saved canvas position from its Docker labels, if any. */
function labelPosition(s: InvService): { x: number; y: number } | null {
  const rx = s.labels?.[CANVAS_X_LABEL];
  const ry = s.labels?.[CANVAS_Y_LABEL];
  if (rx == null || ry == null) return null;
  const x = Number(rx);
  const y = Number(ry);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function edgeFor(e: InvEdge): CanvasEdge {
  const depends = e.kind === 'depends';
  // Two parallel handles keep a network + depends link on the same pair from overlapping.
  return {
    id: `${e.kind}:${e.from}->${e.to}`,
    source: e.from,
    target: e.to,
    sourceHandle: depends ? 'r1' : 'r2',
    targetHandle: depends ? 'l1' : 'l2',
    animated: depends,
    style: depends
      ? { stroke: 'var(--primary)', strokeWidth: 2 }
      : { stroke: NETWORK_TEAL, strokeWidth: 1.75, opacity: 0.85 },
    markerEnd: depends
      ? { type: MarkerType.ArrowClosed, color: 'var(--primary)', width: 16, height: 16 }
      : undefined,
    data: { kind: e.kind, label: e.label ?? null },
  };
}

/**
 * Pure: project the live Docker inventory into a React Flow graph — every service
 * is a free top-level node on the full canvas (no group frame), plus the inferred
 * network/depends edges. Each service's position is Docker-truth: read from its
 * swarmy.canvas.x/y labels; `live` (this-session drags) wins over the label so a
 * 4s poll never snaps a card mid-arrange; unplaced services auto-grid. Drag writes
 * the labels back (see service-canvas).
 */
export function buildGraph(
  inv: Inventory,
  live: Positions = {},
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const serviceNodes: ServiceFlowNode[] = inv.services.map((service, i) => ({
    id: service.id,
    type: 'service',
    position: live[service.id] ?? labelPosition(service) ?? serviceFallback(i),
    data: { service, tone: STATUS_TONE[service.status] },
  }));

  const ids = new Set(inv.services.map((s) => s.id));
  const edges = inv.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map(edgeFor);
  return { nodes: serviceNodes, edges };
}
