import { type Edge as FlowEdge, type Node as FlowNode, MarkerType } from '@xyflow/react';
import type { Inventory, InvEdge, InvService } from '@swarmy/core';
import { UNGROUPED } from '@swarmy/core';

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

// Layout geometry. Services grid inside their project frame; frames flow left→right.
const SERVICE_W = 248;
const SERVICE_H = 178;
const COL_GAP = 22;
const ROW_GAP = 22;
const PAD_X = 22;
const PAD_TOP = 60; // room for the project chip header
const PAD_BOTTOM = 22;
const PROJECT_GAP = 88;
const PER_ROW = 2;

/** Network links have no on-brand teal token — this soft teal matches the token space. */
const NETWORK_TEAL = 'oklch(0.72 0.1 195)';

/** Task-defined mapping: stopped reads as offline; idle is intentional, not an error. */
const STATUS_TONE: Record<InvService['status'], string> = {
  running: 'online',
  degraded: 'warning',
  deploying: 'progress',
  stopped: 'offline',
  idle: 'idle',
};

/** Worst-of for a project dot; idle is lowest because it's a chosen, healthy state. */
function aggregateTone(services: InvService[]): string {
  const tones = new Set(services.map((s) => STATUS_TONE[s.status]));
  for (const t of ['offline', 'warning', 'progress', 'online']) if (tones.has(t)) return t;
  return 'idle';
}

function serviceFallback(index: number): { x: number; y: number } {
  const col = index % PER_ROW;
  const row = Math.floor(index / PER_ROW);
  return { x: PAD_X + col * (SERVICE_W + COL_GAP), y: PAD_TOP + row * (SERVICE_H + ROW_GAP) };
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
 * Pure: project the live Docker inventory into a React Flow graph — one group
 * frame per project (parent node) with its services gridded inside (children with
 * parentId + extent:'parent'), plus the inferred network/depends edges. Saved
 * positions (relative to the parent frame) win; the rest auto-grid so a fresh
 * canvas is never a pile at the origin. Drag is visual only — never real placement.
 */
export function buildGraph(
  inv: Inventory,
  positions: Positions,
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const svcById = new Map(inv.services.map((s) => [s.id, s]));
  const projectNodes: ProjectFlowNode[] = [];
  const serviceNodes: ServiceFlowNode[] = [];
  let cursorX = 0;

  for (const project of inv.projects) {
    const services = project.serviceIds
      .map((id) => svcById.get(id))
      .filter((s): s is InvService => Boolean(s));
    const count = services.length;
    const cols = Math.min(PER_ROW, Math.max(1, count));
    const rows = Math.max(1, Math.ceil(count / cols));
    const width = PAD_X * 2 + cols * SERVICE_W + (cols - 1) * COL_GAP;
    const height = PAD_TOP + rows * SERVICE_H + (rows - 1) * ROW_GAP + PAD_BOTTOM;
    const ungrouped = project.name === UNGROUPED;
    const projectId = `project:${project.name}`;

    projectNodes.push({
      id: projectId,
      type: 'project',
      position: { x: cursorX, y: 0 },
      data: { label: ungrouped ? 'Ungrouped' : project.name, ungrouped, count, tone: aggregateTone(services) },
      draggable: false,
      selectable: false,
      style: { width, height },
    });

    services.forEach((service, i) => {
      serviceNodes.push({
        id: service.id,
        type: 'service',
        parentId: projectId,
        extent: 'parent',
        position: positions[service.id] ?? serviceFallback(i),
        data: { service, tone: STATUS_TONE[service.status] },
      });
    });

    cursorX += width + PROJECT_GAP;
  }

  const ids = new Set(inv.services.map((s) => s.id));
  const edges = inv.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map(edgeFor);
  // Parents must precede children in the node array for React Flow grouping.
  return { nodes: [...projectNodes, ...serviceNodes], edges };
}
