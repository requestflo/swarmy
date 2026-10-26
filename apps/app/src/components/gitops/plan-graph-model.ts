/**
 * Pure: a plan's actions laid over the app's graph — front door (routes),
 * services and jobs, data (resources and linked apps) — each box marked
 * add / change / remove, and the parts the plan doesn't touch kept as ghosts
 * (the live services, and every address, service and store the plan's own
 * desired state still has) so the change reads against what's there.
 */
import type { Gate, PlanActionView, PlanTopology } from './gitops-types';

export type Diff = 'add' | 'change' | 'remove' | 'same';

export interface PlanNode {
  key: string;
  label: string;
  meta?: string;
  /** A third mono line ("wired to db · cache"). */
  note?: string;
  diff: Diff;
  gate?: Gate;
  /** The id lines are drawn between (`route:<host><path>` · `svc:<name>` · `res:<name>`). */
  flow?: string;
}

export interface PlanGraph {
  front: PlanNode[];
  services: PlanNode[];
  data: PlanNode[];
}

const DIFF_OF: Record<string, Diff> = {
  'resource.create': 'add',
  'resource.update': 'change',
  'resource.delete': 'remove',
  'service.remove': 'remove',
  'route.add': 'add',
  'route.update': 'change',
  'route.remove': 'remove',
  'job.create': 'add',
  'job.update': 'change',
  'job.remove': 'remove',
  'link.add': 'add',
  'link.remove': 'remove',
};

/** `storefront_web` → `web` (Docker names services `<stack>_<name>`). */
export function shortName(stack: string, name: string): string {
  return name.startsWith(`${stack}_`) ? name.slice(stack.length + 1) : name;
}

export const routeFlow = (host: string, path: string): string => `route:${host}${path && path !== '/' ? path : ''}`;
export const svcFlow = (name: string): string => `svc:${name}`;
export const resFlow = (name: string): string => `res:${name}`;

function imageMeta(a: PlanActionView, built: Set<string>): string | undefined {
  if (a.image?.image) return a.image.image;
  if (a.image?.fromBuild || (a.name && built.has(a.name))) return 'built from source';
  return undefined;
}

const routeLabel = (host: string, path: string): string => `${host}${path && path !== '/' ? path : ''}`;

/** The graph for `actions` over the stack's live services (short names) and the plan's desired app. */
export function planGraph(actions: PlanActionView[], liveServices: string[], topology?: PlanTopology | null): PlanGraph {
  const g: PlanGraph = { front: [], services: [], data: [] };
  const built = new Set(actions.filter((a) => a.kind === 'build').flatMap((a) => a.services ?? [a.id.replace(/^build:/, '')]));
  const touched = new Set<string>();
  for (const a of actions) {
    const gate = a.gate === 'auto' ? undefined : a.gate;
    if (a.kind === 'build') continue;
    if (a.kind === 'service.deploy') {
      const name = a.name ?? a.id;
      touched.add(svcFlow(name));
      g.services.push({ key: a.id, label: name, meta: imageMeta(a, built), diff: a.op === 'create' ? 'add' : 'change', gate, flow: svcFlow(name) });
      continue;
    }
    const diff = DIFF_OF[a.kind];
    if (!diff) continue;
    if (a.kind.startsWith('route.')) {
      const flow = routeFlow(a.host ?? '?', a.path ?? '/');
      touched.add(flow);
      g.front.push({ key: a.id, label: routeLabel(a.host ?? '?', a.path ?? '/'), meta: 'address', diff, gate, flow });
    } else if (a.kind.startsWith('resource.')) {
      const name = a.name ?? a.id;
      touched.add(resFlow(name));
      g.data.push({ key: a.id, label: name, meta: a.resource?.type ?? a.resourceType, diff, gate, flow: resFlow(name) });
    } else if (a.kind.startsWith('link.')) {
      g.data.push({ key: a.id, label: a.peer ?? a.id, meta: 'connected app', diff, gate });
    } else {
      const job = a.kind.startsWith('job.');
      // A job runs as a service of its own name: keep it out of the ghosts too.
      if (a.name) touched.add(svcFlow(a.name));
      g.services.push({ key: a.id, label: a.name ?? a.id, meta: job ? 'job' : undefined, diff, gate, ...(a.name && !job ? { flow: svcFlow(a.name) } : {}) });
    }
  }
  const ghost = (list: PlanNode[], flow: string, n: Omit<PlanNode, 'diff' | 'flow'>): void => {
    if (touched.has(flow)) return;
    touched.add(flow);
    list.push({ ...n, diff: 'same', flow });
  };
  for (const r of topology?.routes ?? []) ghost(g.front, routeFlow(r.host, r.path), { key: `live:${routeFlow(r.host, r.path)}`, label: routeLabel(r.host, r.path), meta: 'address' });
  for (const s of liveServices) ghost(g.services, svcFlow(s), { key: `live:${s}`, label: s });
  for (const s of topology?.services ?? []) ghost(g.services, svcFlow(s.name), { key: `live:${s.name}`, label: s.name });
  for (const r of topology?.resources ?? []) ghost(g.data, resFlow(r.name), { key: `live:res:${r.name}`, label: r.name, meta: r.type });
  return g;
}

/** "1 to add · 2 to change · 1 to remove". */
export function diffCounts(g: PlanGraph): string {
  const all = [...g.front, ...g.services, ...g.data];
  const n = (d: Diff) => all.filter((x) => x.diff === d).length;
  return [
    n('add') && `${n('add')} to add`,
    n('change') && `${n('change')} to change`,
    n('remove') && `${n('remove')} to remove`,
  ]
    .filter(Boolean)
    .join(' · ');
}
