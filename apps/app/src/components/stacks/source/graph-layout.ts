import type { Graph, GraphKind, GraphNode } from './graph-model';

/**
 * Fixed three-column layout for the live graph (pure): addresses and
 * schedules → services → resources, each column centred, edges as curves
 * from a node's right edge to the next one's left (service → service bends
 * out to the right of the column).
 */
export interface Placed extends GraphNode {
  x: number;
  y: number;
  w: number;
  h: number;
}

const COL_X = [10, 180, 350] as const;
const NODE = { w: 140, h: 46 };
const PILL = { w: 150, h: 30 };
const SLOT = 60;
const PAD = 14;

const column = (k: GraphKind): 0 | 1 | 2 => (k === 'domain' || k === 'job' ? 0 : k === 'service' ? 1 : 2);

export function layoutGraph(g: Graph): { nodes: Placed[]; edges: Array<{ from: string; to: string; d: string }>; width: number; height: number } {
  const cols: GraphNode[][] = [[], [], []];
  for (const n of g.nodes) cols[column(n.kind)]?.push(n);
  const rows = Math.max(1, ...cols.map((c) => c.length));
  const height = rows * SLOT + PAD * 2 - (SLOT - NODE.h);
  const nodes: Placed[] = cols.flatMap((c, ci) => {
    const top = PAD + ((rows - c.length) * SLOT) / 2;
    return c.map((n, i) => {
      const size = n.kind === 'domain' ? PILL : NODE;
      return { ...n, x: COL_X[ci] ?? 0, y: top + i * SLOT + (NODE.h - size.h) / 2, ...size };
    });
  });
  const at = new Map(nodes.map((n) => [n.id, n]));
  const edges = g.edges.flatMap((e) => {
    const a = at.get(e.from);
    const b = at.get(e.to);
    if (!a || !b) return [];
    const ay = a.y + a.h / 2;
    const by = b.y + b.h / 2;
    if (a.x === b.x) {
      const x = a.x + a.w;
      return [{ ...e, d: `M${x} ${ay} C ${x + 26} ${ay} ${x + 26} ${by} ${x} ${by}` }];
    }
    const ax = a.x + a.w;
    const mx = (ax + b.x) / 2;
    return [{ ...e, d: `M${ax} ${ay} C ${mx} ${ay} ${mx} ${by} ${b.x} ${by}` }];
  });
  return { nodes, edges, width: (COL_X[2] ?? 0) + NODE.w + 10, height };
}
