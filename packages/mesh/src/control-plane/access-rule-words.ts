/**
 * An access rule in plain words, for Mesh settings: "Servers can reach
 * Databases on 5432". swarmy's own group names (people.ts) become what they
 * mean: `swarmy:<c>:nodes` is "Servers", `swarmy:<c>:access:<stack>` "People
 * allowed on <app>". Pure.
 */
import type { MeshAccessRule } from '../types';

export interface WordsContext {
  /** Stack id → app name (swarmy's group and policy names carry the id). */
  stacks?: { id: string; name: string }[];
}

const stackName = (id: string, c: WordsContext): string => c.stacks?.find((s) => s.id === id)?.name ?? id;

/** One NetBird group, as a person would say it. */
export function groupWords(group: string, c: WordsContext = {}): string {
  if (group === 'All') return 'Every device';
  const m = /^swarmy:[^:]+:(nodes|access|grant|router|res)(?::(.+))?$/.exec(group);
  if (!m) return group;
  const id = m[2] ?? '';
  switch (m[1]) {
    case 'nodes':
      return 'Servers';
    case 'access':
      return `People allowed on ${stackName(id, c)}`;
    case 'grant':
      return 'A personal grant';
    case 'router':
      return `${stackName(id, c)}'s router`;
    default:
      return `${stackName(id, c)}'s services`;
  }
}

/** A people-access policy (`swarmy-<c>-<stackId>-<svc>`) points at one service: say which. */
function resourceWords(policyName: string, c: WordsContext): string {
  for (const s of c.stacks ?? []) {
    const at = policyName.indexOf(`-${s.id}-`);
    if (policyName.startsWith('swarmy-') && at > 0) return `${s.name}'s ${policyName.slice(at + s.id.length + 2)}`;
  }
  return 'a private service';
}

function list(xs: string[]): string {
  if (xs.length <= 1) return xs[0] ?? 'nobody';
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

function portWords(r: Pick<MeshAccessRule, 'protocol' | 'ports'>): string {
  if (r.protocol === 'all') return 'on every port';
  if (r.protocol === 'icmp') return 'with ping';
  if (!r.ports.length) return `on every ${r.protocol.toUpperCase()} port`;
  return `on ${r.protocol === 'udp' ? 'UDP ' : ''}${list(r.ports)}`;
}

/** "Servers can reach Databases on 5432"; "Servers can reach each other on every port". */
export function accessRuleWords(r: MeshAccessRule, c: WordsContext = {}): string {
  const from = list(r.from.map((g) => groupWords(g, c)));
  const to = r.toResource ? resourceWords(r.name, c) : list(r.to.map((g) => groupWords(g, c)));
  const off = r.enabled ? '' : ' (switched off)';
  const sameSides = !r.toResource && r.from.length === r.to.length && r.from.every((g) => r.to.includes(g));
  if (r.action === 'drop') return `${from} can't reach ${sameSides ? 'each other' : to} ${portWords(r)}${off}`;
  if (sameSides) return `${from} can reach each other ${portWords(r)}${off}`;
  if (r.bidirectional) return `${from} and ${to} can reach each other ${portWords(r)}${off}`;
  return `${from} can reach ${to} ${portWords(r)}${off}`;
}
