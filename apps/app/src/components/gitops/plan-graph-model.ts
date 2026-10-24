/**
 * Pure: a plan's actions laid over the app's graph — front door (routes),
 * services and jobs, data (resources and linked apps) — each box marked
 * add / change / remove, and the live services the plan doesn't touch kept
 * as ghosts so the change reads against what's there.
 */
import type { Gate, PlanActionView } from './gitops-types';

export type Diff = 'add' | 'change' | 'remove' | 'same';

export interface PlanNode {
  key: string;
  label: string;
  meta?: string;
  /** A third mono line ("wired to db · cache"). */
  note?: string;
  diff: Diff;
  gate?: Gate;
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

function imageMeta(a: PlanActionView, built: Set<string>): string | undefined {
  if (a.image?.image) return a.image.image;
  if (a.image?.fromBuild || (a.name && built.has(a.name))) return 'built from source';
  return undefined;
}

/** The graph for `actions` over the stack's live services (short names). */
export function planGraph(actions: PlanActionView[], liveServices: string[]): PlanGraph {
  const g: PlanGraph = { front: [], services: [], data: [] };
  const built = new Set(actions.filter((a) => a.kind === 'build').flatMap((a) => a.services ?? [a.id.replace(/^build:/, '')]));
  const touched = new Set<string>();
  for (const a of actions) {
    const gate = a.gate === 'auto' ? undefined : a.gate;
    if (a.kind === 'build') continue;
    if (a.kind === 'service.deploy') {
      const name = a.name ?? a.id;
      touched.add(name);
      g.services.push({ key: a.id, label: name, meta: imageMeta(a, built), diff: a.op === 'create' ? 'add' : 'change', gate });
      continue;
    }
    const diff = DIFF_OF[a.kind];
    if (!diff) continue;
    if (a.kind.startsWith('route.')) {
      const path = a.path && a.path !== '/' ? a.path : '';
      g.front.push({ key: a.id, label: `${a.host ?? '?'}${path}`, meta: 'address', diff, gate });
    } else if (a.kind.startsWith('resource.')) {
      g.data.push({ key: a.id, label: a.name ?? a.id, meta: a.resource?.type ?? a.resourceType, diff, gate });
    } else if (a.kind.startsWith('link.')) {
      g.data.push({ key: a.id, label: a.peer ?? a.id, meta: 'connected app', diff, gate });
    } else {
      if (a.name) touched.add(a.name);
      g.services.push({ key: a.id, label: a.name ?? a.id, meta: a.kind.startsWith('job.') ? 'job' : undefined, diff, gate });
    }
  }
  for (const s of liveServices) {
    if (!touched.has(s)) g.services.push({ key: `live:${s}`, label: s, diff: 'same' });
  }
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
