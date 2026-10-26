/**
 * Pure: the lines of the plan Graph (board 26) — each address to the service
 * it reaches, each service to the data it uses — between boxes that are on
 * the graph. A line between two untouched boxes is faint (`dim`); one that
 * touches a change is the quiet coral (`base`), dashed when a box at either
 * end is added or removed, like the boxes themselves.
 */
import type { FlowLink } from '@/components/flow/use-flow-paths';
import type { PlanActionView, PlanTopology } from './gitops-types';
import { resFlow, routeFlow, svcFlow, type Diff, type PlanGraph } from './plan-graph-model';

export function planLinks(g: PlanGraph, actions: PlanActionView[], topology?: PlanTopology | null): FlowLink[] {
  const diffOf = new Map<string, Diff>();
  for (const n of [...g.front, ...g.services, ...g.data]) if (n.flow) diffOf.set(n.flow, n.diff);

  const pairs: Array<[string, string]> = [];
  const routeTo = new Map<string, string>();
  for (const r of topology?.routes ?? []) routeTo.set(routeFlow(r.host, r.path), r.service);
  for (const a of actions) if (a.kind.startsWith('route.') && a.route?.service) routeTo.set(routeFlow(a.host ?? '?', a.path ?? '/'), a.route.service);
  for (const [route, service] of routeTo) pairs.push([route, svcFlow(service)]);
  for (const s of topology?.services ?? []) for (const r of s.uses) pairs.push([svcFlow(s.name), resFlow(r)]);

  const out: FlowLink[] = [];
  const seen = new Set<string>();
  for (const [from, to] of pairs) {
    const a = diffOf.get(from);
    const b = diffOf.get(to);
    if (!a || !b || seen.has(`${from}>${to}`)) continue;
    seen.add(`${from}>${to}`);
    const moving = (d: Diff): boolean => d === 'add' || d === 'remove';
    out.push({ from, to, tone: a === 'same' && b === 'same' ? 'dim' : 'base', ...(moving(a) || moving(b) ? { dashed: true } : {}) });
  }
  return out;
}
