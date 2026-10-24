import type { ConfigIssue, DesiredApp, DesiredResource, DesiredService } from '@swarmy/app-config';

/**
 * "What this file builds" (pure): app-config's `DesiredApp` as a graph —
 * addresses and schedules on the left (what starts work), services in the
 * middle, resources on the right — and how it differs from the saved file.
 */
export type GraphKind = 'domain' | 'job' | 'service' | 'resource';
export type NodeState = 'same' | 'added' | 'changed' | 'bad';

export interface GraphNode {
  id: string;
  kind: GraphKind;
  name: string;
  meta: string;
  sig: string;
}
export interface Graph {
  nodes: GraphNode[];
  edges: Array<{ from: string; to: string }>;
}

const clip = (s: string, n = 22): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function serviceMeta(s: DesiredService): string {
  const dir = s.source.kind === 'build' ? s.source.context.replace(/^\.\/?/, '') : '';
  const src = s.source.kind === 'build' ? (dir ? `build ./${dir}` : 'build .') : (s.source.image.split('/').pop() ?? s.source.image);
  // Copies when there's more than one, else the port: a node has room for one fact.
  return [src, s.replicas !== 1 ? `×${s.replicas}` : s.port ? `:${s.port}` : null].filter(Boolean).join(' · ');
}

/** Postgres HA in the Summary glossary's words. */
const HA_WORDS: Record<string, string> = {
  'primary-replica': 'standby',
  failover: 'switch-over',
  geo: 'by region',
  'active-active': 'active-active',
};

function resourceMeta(r: DesiredResource): string {
  switch (r.type) {
    case 'postgres':
      return `postgres ${r.version}${HA_WORDS[r.ha] ? ` · ${HA_WORDS[r.ha]}` : ''}`;
    case 'cache':
      return `${r.purpose === 'queue' ? 'queue' : r.engine} · ${r.memoryMb >= 1024 ? `${r.memoryMb / 1024} GB` : `${r.memoryMb} MB`}`;
    case 'search':
      return r.engine;
    case 'vector':
      return r.on ? `${r.engine} on ${r.on}` : r.engine;
    case 'bucket':
      return `bucket · ${r.access}`;
  }
}

export function graphOf(d: DesiredApp): Graph {
  const routeId = (host: string, path: string): string => `domain:${host}${path === '/' ? '' : path}`;
  const resources = new Set(d.resources.map((r) => r.name));
  const nodes: GraphNode[] = [
    ...d.routes.map((r) => ({ id: routeId(r.host, r.path), kind: 'domain' as const, name: clip(`${r.host}${r.path === '/' ? '' : r.path}`, 26), meta: '', sig: r.sig })),
    ...d.jobs.map((j) => ({ id: `job:${j.name}`, kind: 'job' as const, name: j.name, meta: j.schedule, sig: j.sig })),
    ...d.services.map((s) => ({ id: `service:${s.name}`, kind: 'service' as const, name: s.name, meta: clip(serviceMeta(s)), sig: s.sig })),
    ...d.resources.map((r) => ({ id: `resource:${r.name}`, kind: 'resource' as const, name: r.name, meta: clip(resourceMeta(r)), sig: r.sig })),
  ];
  const edges = [
    ...d.routes.map((r) => ({ from: routeId(r.host, r.path), to: `service:${r.service}` })),
    ...d.jobs.flatMap((j) => (j.service ? [{ from: `job:${j.name}`, to: `service:${j.service}` }] : [])),
    ...d.services.flatMap((s) => s.dependsOn.map((t) => ({ from: `service:${s.name}`, to: `${resources.has(t) ? 'resource' : 'service'}:${t}` }))),
  ];
  const ids = new Set(nodes.map((n) => n.id));
  return { nodes, edges: edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
}

/** The node a problem's path points into (`services.web.port` → `service:web`). */
export function nodeIdOf(issue: Pick<ConfigIssue, 'path'>): string | null {
  const [top, name] = issue.path;
  const kind = top === 'services' ? 'service' : top === 'resources' ? 'resource' : top === 'jobs' ? 'job' : null;
  return kind && typeof name === 'string' ? `${kind}:${name}` : null;
}

export interface GraphDiff {
  state: Map<string, NodeState>;
  removed: GraphNode[];
  /** "+1 resource", "−1 job", "2 changed". */
  chips: Array<{ text: string; tone: 'ok' | 'bad' | 'warn' }>;
}

const WORD: Record<GraphKind, [string, string]> = {
  domain: ['address', 'addresses'],
  job: ['job', 'jobs'],
  service: ['service', 'services'],
  resource: ['resource', 'resources'],
};
const count = (n: number, k: GraphKind): string => `${n} ${WORD[k][n === 1 ? 0 : 1]}`;

export function diffGraphs(saved: Graph | null, cur: Graph, issues: readonly ConfigIssue[] = []): GraphDiff {
  const before = new Map((saved?.nodes ?? []).map((n) => [n.id, n]));
  const after = new Set(cur.nodes.map((n) => n.id));
  const bad = new Set(issues.filter((i) => i.severity === 'error').map(nodeIdOf).filter((x): x is string => x !== null));
  const state = new Map<string, NodeState>();
  for (const n of cur.nodes) {
    const was = before.get(n.id);
    state.set(n.id, bad.has(n.id) ? 'bad' : !saved ? 'same' : !was ? 'added' : was.sig !== n.sig ? 'changed' : 'same');
  }
  const removed = saved ? saved.nodes.filter((n) => !after.has(n.id)) : [];
  const chips: GraphDiff['chips'] = [];
  for (const k of ['service', 'resource', 'domain', 'job'] as const) {
    const added = cur.nodes.filter((n) => n.kind === k && state.get(n.id) === 'added').length;
    const gone = removed.filter((n) => n.kind === k).length;
    if (added) chips.push({ text: `+${count(added, k)}`, tone: 'ok' });
    if (gone) chips.push({ text: `−${count(gone, k)}`, tone: 'bad' });
  }
  const changed = [...state.values()].filter((s) => s === 'changed').length;
  if (changed) chips.push({ text: `${changed} changed`, tone: 'warn' });
  return { state, removed, chips };
}
