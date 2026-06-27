import type { Node as FlowNode } from '@xyflow/react';
import type { NodeSummary, ServiceSummary } from '@swarmy/core';
import { SERVICE_STATUS_TONE } from '@swarmy/core';

export interface ServiceNodeData extends Record<string, unknown> {
  service: ServiceSummary;
  /** Human label for where this runs: a node name, "cluster", or "unscheduled". */
  placement: string;
  tone: string;
  stackName: string | null;
}

export type ServiceFlowNode = FlowNode<ServiceNodeData, 'service'>;

const COL_W = 300;
const ROW_H = 168;
const PER_ROW = 4;

/** Where does this service run? Pinned node name, else cluster-wide / unscheduled. */
function placementLabel(svc: ServiceSummary, nodesById: Map<string, NodeSummary>): string {
  if (svc.nodeId) return nodesById.get(svc.nodeId)?.name ?? 'pinned node';
  if (svc.replicas.running > 0) return 'cluster';
  return 'unscheduled';
}

/**
 * Pure: turn the live services (+ node + stack lookups + saved positions) into
 * React Flow nodes. Services without a saved position fall into a tidy grid so a
 * fresh canvas is never a pile at the origin. Drag only ever moves cards — this
 * never reflects or changes real placement.
 */
export function buildServiceNodes(
  services: ServiceSummary[],
  nodesById: Map<string, NodeSummary>,
  stackNameById: Map<string, string>,
  positions: Record<string, { x: number; y: number }>,
): ServiceFlowNode[] {
  return services.map((service, i) => ({
    id: service.id,
    type: 'service',
    position: positions[service.id] ?? { x: (i % PER_ROW) * COL_W, y: Math.floor(i / PER_ROW) * ROW_H },
    data: {
      service,
      placement: placementLabel(service, nodesById),
      tone: SERVICE_STATUS_TONE[service.status] ?? 'neutral',
      stackName: service.stackId ? (stackNameById.get(service.stackId) ?? null) : null,
    },
  }));
}
