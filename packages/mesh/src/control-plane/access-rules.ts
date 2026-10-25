/**
 * Mesh access rules over NetBird's policies (groups → groups, ports,
 * protocols): list them, add a simple one, remove a simple one. The NetBird
 * driver's optional access-rule methods call these; the mapping is pure and
 * tested against an in-memory {@link PolicyAdminApi}.
 *
 * swarmy's own policies and groups (`swarmy:<c>:*` / `swarmy-<c>-*`: servers ↔
 * servers, people access) are listed but never changed here, and a new rule
 * never names them or NetBird's "All": people reach services only through
 * their grants, and nothing targets `swarmy:<c>:nodes` from outside swarmy.
 * New rules are named outside swarmy's namespace, so the people sync (which
 * deletes unknown `swarmy-<c>-*` policies) never touches them.
 */
import { MeshAccessRuleRefused } from '../errors';
import type { MeshAccessList, MeshAccessRule, NewMeshAccessRule, PolicyAdminApi } from '../types';
import type { NbGroup, NbPolicy, NbPolicyRule } from './netbird-admin';

/** True for a NetBird object name swarmy manages (any cluster). */
export function isSwarmyObject(name: string): boolean {
  return name.startsWith('swarmy:') || name.startsWith('swarmy-');
}

const MAX_PORTS = 16;

function names(refs: NbPolicyRule['sources'], byId: Map<string, string>): string[] {
  return (refs ?? []).map((r) => (typeof r === 'string' ? (byId.get(r) ?? r) : (r.name ?? byId.get(r.id) ?? r.id)));
}

function ports(r: NbPolicyRule): string[] {
  return [...(r.ports ?? []), ...(r.port_ranges ?? []).map((p) => (p.start === p.end ? String(p.start) : `${p.start}-${p.end}`))];
}

/** Every rule of every policy, as driver-neutral {@link MeshAccessRule}s. */
export function policiesToRules(policies: NbPolicy[], groups: NbGroup[]): MeshAccessRule[] {
  const byId = new Map(groups.map((g) => [g.id, g.name]));
  return policies.flatMap((p) =>
    p.rules.map((r, i): MeshAccessRule => {
      const from = names(r.sources, byId);
      const to = names(r.destinations, byId);
      const toResource = Boolean(r.destinationResource);
      const swarmys = isSwarmyObject(p.name) || [...from, ...to].some(isSwarmyObject);
      return {
        id: p.rules.length === 1 ? (p.id ?? p.name) : `${p.id ?? p.name}:${i}`,
        name: p.name,
        enabled: p.enabled && r.enabled,
        from,
        to,
        toResource,
        protocol: r.protocol,
        ports: ports(r),
        bidirectional: r.bidirectional,
        action: r.action,
        managedBySwarmy: swarmys,
        simple: p.rules.length === 1 && r.action === 'accept' && !toResource && from.length === 1 && to.length === 1 && !(p.source_posture_checks ?? []).length,
      };
    }),
  );
}

/** Groups a new rule may name: NetBird's own, never swarmy's or "All". */
export function offerableGroups(groups: NbGroup[]): string[] {
  return groups
    .map((g) => g.name)
    .filter((n) => n !== 'All' && !isSwarmyObject(n))
    .sort((a, b) => a.localeCompare(b));
}

/** Why `r` can't be added, in plain words, or null. */
export function checkNewRule(r: NewMeshAccessRule, list: MeshAccessList): string | null {
  for (const g of [r.from, r.to]) {
    if (!list.groups.includes(g)) return `${g} isn't a group you can use in a rule (pick one of your NetBird groups; swarmy's own and "All" are off limits)`;
  }
  if (r.protocol === 'all' && r.ports.length) return 'a rule for every protocol covers every port: leave the ports out, or pick TCP or UDP';
  if (r.ports.length > MAX_PORTS) return `at most ${MAX_PORTS} ports in one rule`;
  const bad = r.ports.find((p) => !Number.isInteger(p) || p < 1 || p > 65535);
  if (bad !== undefined) return `${bad} isn't a port (1 to 65535)`;
  const want = [...new Set(r.ports)].sort((a, b) => a - b).map(String).join(',');
  const dup = list.rules.find(
    (x) => x.from.length === 1 && x.to.length === 1 && x.from[0] === r.from && x.to[0] === r.to && x.protocol === r.protocol && [...x.ports].sort((a, b) => Number(a) - Number(b)).join(',') === want,
  );
  return dup ? `that rule already exists (${dup.name})` : null;
}

/** The NetBird policy for a new simple rule (one-way, accept), named outside swarmy's namespace. */
export function ruleToPolicy(r: NewMeshAccessRule, groupIds: Map<string, string>): NbPolicy {
  const ps = [...new Set(r.ports)].sort((a, b) => a - b).map(String);
  const name = `${r.from} → ${r.to}${r.protocol === 'all' ? '' : ps.length ? ` ${r.protocol}/${ps.join(',')}` : ` ${r.protocol}`}`;
  return {
    name,
    description: 'Added in swarmy (Mesh settings)',
    enabled: true,
    rules: [
      {
        name,
        enabled: true,
        action: 'accept',
        bidirectional: false,
        protocol: r.protocol,
        ...(ps.length ? { ports: ps } : {}),
        sources: [groupIds.get(r.from)!],
        destinations: [groupIds.get(r.to)!],
      },
    ],
  };
}

export async function listNetbirdAccessRules(api: PolicyAdminApi): Promise<MeshAccessList> {
  const [groups, policies] = await Promise.all([api.listGroups(), api.listPolicies()]);
  return { rules: policiesToRules(policies, groups), groups: offerableGroups(groups) };
}

export async function addNetbirdAccessRule(api: PolicyAdminApi, r: NewMeshAccessRule): Promise<MeshAccessRule> {
  const groups = await api.listGroups();
  const list = { rules: policiesToRules(await api.listPolicies(), groups), groups: offerableGroups(groups) };
  const why = checkNewRule(r, list);
  if (why) throw new MeshAccessRuleRefused(why);
  const created = await api.createPolicy(ruleToPolicy(r, new Map(groups.map((g) => [g.name, g.id]))));
  return policiesToRules([created], groups)[0]!;
}

export async function removeNetbirdAccessRule(api: PolicyAdminApi, id: string): Promise<void> {
  const groups = await api.listGroups();
  const rule = policiesToRules(await api.listPolicies(), groups).find((x) => x.id === id);
  if (!rule) throw new MeshAccessRuleRefused(`no access rule ${id} (removed already?)`);
  if (rule.managedBySwarmy) throw new MeshAccessRuleRefused(`${rule.name} is swarmy's own rule: it follows the servers and people access, so it can't be removed here`);
  if (!rule.simple) throw new MeshAccessRuleRefused(`${rule.name} is more than one group reaching another (several rules, a resource or posture checks): change it in NetBird`);
  await api.deletePolicy(id);
}
