import { type Edge as FlowEdge, type Node as FlowNode, MarkerType } from '@xyflow/react';
import type { Inventory, InvEdge, InvService } from '@swarmy/core';
import { aggregateTone, STATUS_TONE } from './stack-aggregates';

export interface ServiceNodeData extends Record<string, unknown> {
  service: InvService;
  /** Status token name (online | warning | progress | offline | idle). */
  tone: string;
}
/** One per-region summary chip on a logical-app frame (e.g. `eu × 5`). */
export interface RegionBadge {
  region: string;
  /** Declared (intent) replica count for this region. */
  replicas: number;
  /** Status token for the badge dot — sibling health, or progress while converging. */
  tone: string;
}
export interface ProjectNodeData extends Record<string, unknown> {
  /** Display label ("Ungrouped" for the catch-all project). */
  label: string;
  ungrouped: boolean;
  count: number;
  /** Aggregate status token for the project dot. */
  tone: string;
  /**
   * When this frame groups a logical app's per-region siblings (epic #7), the
   * per-region summary badges (eu×5, us×2…). Absent for a plain Docker-stack
   * frame, so plain frames render unchanged.
   */
  regionBadges?: RegionBadge[];
}

/**
 * A managed-DB cluster frame (epic #8): a stack's primary + replica services
 * grouped into ONE db-cluster group node, badged with a DB glyph and per-role
 * health. Member service cards nest inside the frame exactly like region
 * siblings; clicking the frame opens the cluster panel (db-cluster-panel.tsx).
 */
export interface DbClusterNodeData extends Record<string, unknown> {
  /** Docker stack the cluster lives in (the panel scopes its topology query by this). */
  stack: string;
  /** Cluster name (the `swarmy.db.cluster` label value). */
  cluster: string;
  /** Engine (`swarmy.db.engine`), e.g. "postgres". */
  engine: string;
  /** Member service count (primary + replicas). */
  count: number;
  /** Aggregate (worst-of) status token for the frame dot. */
  tone: string;
  /** Primary role summary — whether a primary exists + its live health token. */
  primary: { present: boolean; tone: string };
  /** Replica role summary — desired/running tasks + live health token. */
  replicas: { desired: number; running: number; tone: string };
}

export type ServiceFlowNode = FlowNode<ServiceNodeData, 'service'>;
export type ProjectFlowNode = FlowNode<ProjectNodeData, 'project'>;
export type DbClusterFlowNode = FlowNode<DbClusterNodeData, 'dbCluster'>;
export type CanvasNode = ServiceFlowNode | ProjectFlowNode | DbClusterFlowNode;
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

// Region-group geometry: a logical app frames its per-region siblings (+ the
// parent card) like project-group-node frames a stack. GROUP_HEADER reserves the
// top band the frame paints its label chip + region badges into.
const GROUP_HEADER = 60;
const GROUP_PAD = 20;
const GROUP_PER_ROW = 2;

/** Network links have no on-brand teal token — this soft teal matches the token space. */
const NETWORK_TEAL = 'oklch(0.72 0.1 195)';

// Parses the declared per-region replica labels (`swarmy.region.<region>.replicas`)
// the parent app carries — the same Docker-truth the region tRPC service reads.
const REGION_REPLICAS_RE = /^swarmy\.region\.(.+)\.replicas$/;

// Managed-DB cluster Docker-truth labels (mirror @swarmy/trpc manageddb.service).
// A service carrying both `swarmy.db.cluster` + `swarmy.db.engine` is a member of a
// Postgres cluster; `swarmy.db.role` distinguishes the single primary from replicas.
const DB_CLUSTER_LABEL = 'swarmy.db.cluster';
const DB_ROLE_LABEL = 'swarmy.db.role';
const DB_ENGINE_LABEL = 'swarmy.db.engine';

function dbRole(s: InvService): string | undefined {
  return s.labels?.[DB_ROLE_LABEL];
}
/** Layout order within a db-cluster frame: primary leads, then replicas, then any other member. */
function dbRoleRank(s: InvService): number {
  const r = dbRole(s);
  return r === 'primary' ? 0 : r === 'replica' ? 1 : 2;
}

// STATUS_TONE + aggregateTone are shared with the stack-overview cards so the
// per-stack worst-of dot matches in both views (see ./stack-aggregates).

function serviceFallback(index: number, xOffset = 0): { x: number; y: number } {
  const col = index % PER_ROW;
  const row = Math.floor(index / PER_ROW);
  return { x: xOffset + col * (SERVICE_W + COL_GAP), y: row * (SERVICE_H + ROW_GAP) };
}

/** Child grid position *relative to the frame* (cards nest under the group node). */
function memberFallback(index: number): { x: number; y: number } {
  const col = index % GROUP_PER_ROW;
  const row = Math.floor(index / GROUP_PER_ROW);
  return {
    x: GROUP_PAD + col * (SERVICE_W + COL_GAP),
    y: GROUP_HEADER + row * (SERVICE_H + ROW_GAP),
  };
}

/** Declared per-region replica intent parsed from a parent app's Docker labels. */
function declaredRegionReplicas(labels: Record<string, string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, value] of Object.entries(labels)) {
    const match = REGION_REPLICAS_RE.exec(key);
    if (!match?.[1]) continue;
    const n = Number.parseInt(value, 10);
    if (Number.isNaN(n) || n < 0) continue;
    out.set(match[1], n);
  }
  return out;
}

/**
 * Summary badges for a logical app's frame: union of the regions it *declares*
 * (parent `swarmy.region.<region>.replicas` labels) and the regions it has
 * *materialised* (running `<name>-<region>` siblings). The count is the declared
 * intent (falling back to the sibling's desired); the tone is the sibling's live
 * health, or `progress` while a declared region is still converging.
 */
function regionBadges(parent: InvService | undefined, siblings: InvService[]): RegionBadge[] {
  const declared = parent ? declaredRegionReplicas(parent.labels) : new Map<string, number>();
  const sibByRegion = new Map<string, InvService>();
  for (const s of siblings) if (s.region) sibByRegion.set(s.region, s);

  const regions = [...new Set([...declared.keys(), ...sibByRegion.keys()])].sort((a, b) =>
    a.localeCompare(b),
  );
  return regions.map((region) => {
    const sib = sibByRegion.get(region);
    return {
      region,
      replicas: declared.get(region) ?? sib?.replicas.desired ?? 0,
      tone: sib ? STATUS_TONE[sib.status] : 'progress',
    };
  });
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
 * Pure: project the live Docker inventory into a React Flow graph.
 *
 * Per-region siblings (epic #7) are grouped: any service carrying
 * `swarmy.region.parent=<app>` is a regional materialisation of `<app>`, so it —
 * plus the parent card itself, when present — nests inside one logical-app frame
 * (a `project` group node) carrying per-region badges (eu×5, us×2…). The frame
 * reuses the project-group-node grouping approach; cards nest via React Flow
 * `parentId`/`extent`. Every other service stays a free top-level node, gridded to
 * the right of the frames so the two never overlap.
 *
 * Position is Docker-truth: read from `swarmy.canvas.x/y` labels (for a nested
 * card these are interpreted relative to its frame, matching how a drag of that
 * card persists); `live` (this-session drags) wins so a 4s poll never snaps a card
 * mid-arrange; unplaced services auto-grid. Drag writes the labels back (see
 * service-canvas).
 */
export function buildGraph(
  inv: Inventory,
  live: Positions = {},
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  // Group regional siblings by their logical parent app name.
  const siblingsByParent = new Map<string, InvService[]>();
  for (const s of inv.services) {
    if (!s.regionParent) continue;
    const list = siblingsByParent.get(s.regionParent) ?? [];
    list.push(s);
    siblingsByParent.set(s.regionParent, list);
  }

  const byName = new Map(inv.services.map((s) => [s.name, s] as const));
  const grouped = new Set<string>(); // service ids nested inside a frame
  const groupNodes: ProjectFlowNode[] = [];
  const dbGroupNodes: DbClusterFlowNode[] = [];
  const childNodes: ServiceFlowNode[] = [];
  let groupY = 0;
  let groupsColWidth = 0;

  for (const parentName of [...siblingsByParent.keys()].sort((a, b) => a.localeCompare(b))) {
    const siblings = siblingsByParent
      .get(parentName)!
      .slice()
      .sort((a, b) => (a.region ?? '').localeCompare(b.region ?? ''));
    // The parent card (the label-holder) leads, then its regional siblings. Only
    // a true logical parent (not itself a sibling of something else) is folded in,
    // so a node id can never land in two frames.
    const parentSvc = byName.get(parentName);
    const members = parentSvc && !parentSvc.regionParent ? [parentSvc, ...siblings] : siblings;

    const cols = Math.min(GROUP_PER_ROW, members.length);
    const rows = Math.ceil(members.length / GROUP_PER_ROW);
    const width = GROUP_PAD * 2 + cols * SERVICE_W + (cols - 1) * COL_GAP;
    const height = GROUP_HEADER + GROUP_PAD + rows * SERVICE_H + (rows - 1) * ROW_GAP;
    const groupId = `region-group:${parentName}`;

    groupNodes.push({
      id: groupId,
      type: 'project',
      position: { x: 0, y: groupY },
      // A frame is a backdrop: it stays anchored while its cards drag within it.
      draggable: false,
      selectable: false,
      style: { width, height },
      data: {
        label: parentName,
        ungrouped: false,
        count: members.length,
        tone: aggregateTone(members),
        regionBadges: regionBadges(parentSvc, siblings),
      },
    });

    members.forEach((m, i) => {
      grouped.add(m.id);
      childNodes.push({
        id: m.id,
        type: 'service',
        parentId: groupId,
        extent: 'parent',
        position: live[m.id] ?? labelPosition(m) ?? memberFallback(i),
        data: { service: m, tone: STATUS_TONE[m.status] },
      });
    });

    groupsColWidth = Math.max(groupsColWidth, width);
    groupY += height + ROW_GAP;
  }

  // ── Managed-DB clusters (epic #8) ───────────────────────────────────────
  // Group a stack's cluster members (the primary + replica services, marked by
  // `swarmy.db.cluster` + `swarmy.db.engine`) into ONE db-cluster frame — the same
  // nested-frame approach as region groups, but branded with a DB glyph + per-role
  // health and clickable to open the cluster panel. Region siblings are grouped
  // above and anything already framed is skipped, so a service never lands twice.
  const dbByCluster = new Map<string, InvService[]>();
  for (const s of inv.services) {
    if (grouped.has(s.id)) continue;
    if (!s.labels?.[DB_CLUSTER_LABEL] || !s.labels?.[DB_ENGINE_LABEL]) continue;
    // Cluster names are stack-scoped; join on a space (neither stack nor cluster
    // names admit one) so two stacks can each carry a "main" cluster independently.
    const key = `${s.stack} ${s.labels[DB_CLUSTER_LABEL]}`;
    const list = dbByCluster.get(key) ?? [];
    list.push(s);
    dbByCluster.set(key, list);
  }

  for (const key of [...dbByCluster.keys()].sort((a, b) => a.localeCompare(b))) {
    const members = dbByCluster
      .get(key)!
      .slice()
      .sort((a, b) => dbRoleRank(a) - dbRoleRank(b) || a.name.localeCompare(b.name));
    const sep = key.indexOf(' ');
    const stack = key.slice(0, sep);
    const cluster = key.slice(sep + 1);

    const cols = Math.min(GROUP_PER_ROW, members.length);
    const rows = Math.ceil(members.length / GROUP_PER_ROW);
    const width = GROUP_PAD * 2 + cols * SERVICE_W + (cols - 1) * COL_GAP;
    const height = GROUP_HEADER + GROUP_PAD + rows * SERVICE_H + (rows - 1) * ROW_GAP;
    const groupId = `db-group:${stack}:${cluster}`;

    const primary = members.find((m) => dbRole(m) === 'primary');
    const replica = members.find((m) => dbRole(m) === 'replica');

    dbGroupNodes.push({
      id: groupId,
      type: 'dbCluster',
      position: { x: 0, y: groupY },
      // A frame is a backdrop: anchored while members drag within it. Unlike a region
      // frame it's selectable, so a click on the frame opens the cluster panel.
      draggable: false,
      selectable: true,
      style: { width, height },
      data: {
        stack,
        cluster,
        engine:
          primary?.labels[DB_ENGINE_LABEL] ?? replica?.labels[DB_ENGINE_LABEL] ?? 'postgres',
        count: members.length,
        tone: aggregateTone(members),
        primary: primary
          ? { present: true, tone: STATUS_TONE[primary.status] }
          : { present: false, tone: 'offline' },
        replicas: {
          desired: replica?.replicas.desired ?? 0,
          running: replica?.replicas.running ?? 0,
          tone: replica ? STATUS_TONE[replica.status] : 'idle',
        },
      },
    });

    members.forEach((m, i) => {
      grouped.add(m.id);
      childNodes.push({
        id: m.id,
        type: 'service',
        parentId: groupId,
        extent: 'parent',
        position: live[m.id] ?? labelPosition(m) ?? memberFallback(i),
        data: { service: m, tone: STATUS_TONE[m.status] },
      });
    });

    groupsColWidth = Math.max(groupsColWidth, width);
    groupY += height + ROW_GAP;
  }

  // Free top-level services grid to the right of the frame column so a frame and a
  // standalone card never collide; with no frames this is the original flat grid.
  const flatX = groupsColWidth > 0 ? groupsColWidth + COL_GAP * 2 : 0;
  const serviceNodes: ServiceFlowNode[] = inv.services
    .filter((s) => !grouped.has(s.id))
    .map((service, i) => ({
      id: service.id,
      type: 'service',
      position: live[service.id] ?? labelPosition(service) ?? serviceFallback(i, flatX),
      data: { service, tone: STATUS_TONE[service.status] },
    }));

  // Frames must precede their nested cards in the array (React Flow parent rule);
  // both region (`project`) and db-cluster frames lead, then all nested cards.
  const nodes: CanvasNode[] = [...groupNodes, ...dbGroupNodes, ...childNodes, ...serviceNodes];

  const ids = new Set(inv.services.map((s) => s.id));
  const edges = inv.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map(edgeFor);
  return { nodes, edges };
}
