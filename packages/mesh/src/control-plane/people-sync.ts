/**
 * Converge a NetBird control plane onto swarmy's desired state: the bootstrap
 * policy set, the people-access plan (`buildPeopleAccessPlan`) and the user
 * sync (`planUserSync`). Talks only to {@link NetbirdAdminApi}; creates,
 * updates and deletes ONLY objects in the cluster's `swarmy:<c>:*` /
 * `swarmy-<c>-*` namespace and never touches anything else (plan §8.3).
 *
 * Idempotent: a second run against an unchanged plan writes nothing.
 */
import type { NetbirdAdminApi, NbPolicy, NbPolicyRule } from './netbird-admin';
import {
  isSwarmyManaged,
  nodesGroup,
  nodesPolicyName,
  planUserSync,
  swarmyPrefix,
  type PeopleAccessPlan,
  type PersonAccess,
  type UserSyncAction,
} from '../people';

export interface SyncChange {
  op: 'create' | 'update' | 'delete';
  kind: 'group' | 'network' | 'resource' | 'router' | 'policy' | 'zone' | 'record' | 'user' | 'peer' | 'setting' | 'connector';
  name: string;
}

export interface SyncResult {
  changes: SyncChange[];
}

const idOf = (x: { id: string } | string): string => (typeof x === 'string' ? x : x.id);

/** The default NetBird policy (All ↔ All) the combined server always creates (spike §11.3). */
export function isDefaultAllPolicy(p: NbPolicy, allGroupId: string | undefined): boolean {
  if (p.name !== 'Default' || p.rules.length !== 1 || !allGroupId) return false;
  const r = p.rules[0]!;
  const src = (r.sources ?? []).map(idOf);
  const dst = (r.destinations ?? []).map(idOf);
  return src.length === 1 && dst.length === 1 && src[0] === allGroupId && dst[0] === allGroupId && r.protocol === 'all';
}

async function groupMap(api: NetbirdAdminApi): Promise<Map<string, string>> {
  return new Map((await api.listGroups()).map((g) => [g.name, g.id]));
}

async function ensureGroup(api: NetbirdAdminApi, groups: Map<string, string>, name: string, changes: SyncChange[]): Promise<string> {
  const have = groups.get(name);
  if (have) return have;
  const created = await api.createGroup(name);
  groups.set(name, created.id);
  changes.push({ op: 'create', kind: 'group', name });
  return created.id;
}

export interface BootstrapOptions {
  cluster: string;
  /** People's peers log in again after this long (plan §3.1: 12 h). */
  peerLoginExpirationSec?: number;
}

/**
 * The bootstrap policy set (plan §2.3 step 4): delete the Default All ↔ All
 * policy, ensure `swarmy:<c>:nodes` and nodes ↔ nodes, and the account
 * settings people access relies on. Safe to run on every reconcile.
 */
export async function bootstrapControlPlane(api: NetbirdAdminApi, opts: BootstrapOptions): Promise<SyncResult> {
  const changes: SyncChange[] = [];
  const groups = await groupMap(api);
  const allId = groups.get('All');
  const policies = await api.listPolicies();
  for (const p of policies) {
    if (p.id && isDefaultAllPolicy(p, allId)) {
      await api.deletePolicy(p.id);
      changes.push({ op: 'delete', kind: 'policy', name: p.name });
    }
  }
  const nodes = await ensureGroup(api, groups, nodesGroup(opts.cluster), changes);
  const want: NbPolicy = {
    name: nodesPolicyName(opts.cluster),
    description: 'swarmy: servers reach each other (swarm, overlays)',
    enabled: true,
    rules: [
      {
        name: nodesPolicyName(opts.cluster),
        enabled: true,
        action: 'accept',
        bidirectional: true,
        protocol: 'all',
        sources: [nodes],
        destinations: [nodes],
      },
    ],
  };
  const existing = policies.find((p) => p.name === want.name);
  if (!existing) {
    await api.createPolicy(want);
    changes.push({ op: 'create', kind: 'policy', name: want.name });
  } else if (!sameRule(existing.rules[0], want.rules[0]!)) {
    await api.updatePolicy(existing.id!, want);
    changes.push({ op: 'update', kind: 'policy', name: want.name });
  }

  const account = await api.getAccount();
  const s = account.settings;
  const expiry = opts.peerLoginExpirationSec ?? 12 * 3600;
  const extra = { ...(s.extra ?? {}) };
  const needs =
    s.peer_login_expiration !== expiry ||
    s.peer_login_expiration_enabled !== true ||
    s.groups_propagation_enabled !== true ||
    extra.user_approval_required !== false;
  if (needs) {
    await api.updateAccountSettings(account.id, {
      ...s,
      peer_login_expiration: expiry,
      peer_login_expiration_enabled: true,
      groups_propagation_enabled: true,
      extra: { ...extra, user_approval_required: false },
    });
    changes.push({ op: 'update', kind: 'setting', name: 'account' });
  }
  return { changes };
}

function sortedIds(xs: ({ id: string } | string)[] | null | undefined): string[] {
  return (xs ?? []).map(idOf).sort();
}

function sameRule(a: NbPolicyRule | undefined, b: NbPolicyRule): boolean {
  if (!a) return false;
  const eq = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i]);
  return (
    a.enabled === b.enabled &&
    a.action === b.action &&
    a.bidirectional === b.bidirectional &&
    a.protocol === b.protocol &&
    eq([...(a.ports ?? [])].sort(), [...(b.ports ?? [])].sort()) &&
    eq(sortedIds(a.sources), sortedIds(b.sources)) &&
    eq(sortedIds(a.destinations), sortedIds(b.destinations)) &&
    (a.destinationResource?.id ?? '') === (b.destinationResource?.id ?? '')
  );
}

/**
 * Converge the people-access plan. Order matters: groups → networks
 * (resources, routers) → policies → zones, then deletions in reverse so no
 * object is removed while something still references it.
 */
export async function applyPeopleAccessPlan(api: NetbirdAdminApi, plan: PeopleAccessPlan): Promise<SyncResult> {
  const c = plan.cluster;
  const changes: SyncChange[] = [];
  const groups = await groupMap(api);
  for (const g of plan.groups) await ensureGroup(api, groups, g, changes);

  // Networks + resources + routers.
  const networks = await api.listNetworks();
  const netIds = new Map(networks.map((n) => [n.name, n.id]));
  const resourceIds = new Map<string, string>(); // `${net}/${res}` → id
  for (const n of plan.networks) {
    let nid = netIds.get(n.name);
    if (!nid) {
      nid = (await api.createNetwork({ name: n.name, description: n.description })).id;
      netIds.set(n.name, nid);
      changes.push({ op: 'create', kind: 'network', name: n.name });
    }
    const have = await api.listResources(nid);
    const haveByName = new Map(have.map((r) => [r.name, r]));
    for (const r of n.resources) {
      const body = { name: r.name, address: r.address, enabled: true, groups: [groups.get(r.group)!] };
      const cur = haveByName.get(r.name);
      if (!cur) {
        const created = await api.createResource(nid, body);
        resourceIds.set(`${n.name}/${r.name}`, created.id);
        changes.push({ op: 'create', kind: 'resource', name: `${n.name}/${r.name}` });
      } else {
        resourceIds.set(`${n.name}/${r.name}`, cur.id);
        const curGroups = cur.groups.map((g) => g.id).sort();
        if (cur.address !== r.address || !cur.enabled || curGroups.join() !== body.groups.join()) {
          await api.updateResource(nid, cur.id, body);
          changes.push({ op: 'update', kind: 'resource', name: `${n.name}/${r.name}` });
        }
      }
    }
    for (const cur of have) {
      if (!n.resources.some((r) => r.name === cur.name)) {
        await api.deleteResource(nid, cur.id);
        changes.push({ op: 'delete', kind: 'resource', name: `${n.name}/${cur.name}` });
      }
    }
    const routerGroupId = groups.get(n.routerGroup)!;
    const routers = await api.listRouters(nid);
    if (!routers.some((r) => (r.peer_groups ?? []).includes(routerGroupId))) {
      await api.createRouter(nid, { peer_groups: [routerGroupId], masquerade: true, metric: 9999, enabled: true });
      changes.push({ op: 'create', kind: 'router', name: n.name });
    }
  }

  // Policies.
  const policies = await api.listPolicies();
  const polByName = new Map(policies.map((p) => [p.name, p]));
  for (const p of plan.policies) {
    const resId = resourceIds.get(`${p.network}/${p.resource}`);
    if (!resId) continue;
    const want: NbPolicy = {
      name: p.name,
      description: 'swarmy people access (generated)',
      enabled: true,
      rules: [
        {
          name: p.name,
          enabled: true,
          action: 'accept',
          bidirectional: false,
          protocol: p.protocol,
          ports: p.ports,
          sources: p.sources.map((s) => groups.get(s)!),
          destinationResource: { id: resId, type: 'host' },
        },
      ],
    };
    const cur = polByName.get(p.name);
    if (!cur) {
      await api.createPolicy(want);
      changes.push({ op: 'create', kind: 'policy', name: p.name });
    } else if (!sameRule(cur.rules[0], want.rules[0]!) || !cur.enabled) {
      await api.updatePolicy(cur.id!, want);
      changes.push({ op: 'update', kind: 'policy', name: p.name });
    }
  }

  // Zones + records.
  const zones = await api.listZones();
  const zoneByName = new Map(zones.map((z) => [z.name, z]));
  for (const z of plan.zones) {
    const body = {
      name: z.name,
      domain: z.domain,
      enabled: true,
      enable_search_domain: false,
      distribution_groups: z.distributionGroups.map((g) => groups.get(g)!).sort(),
    };
    let cur = zoneByName.get(z.name);
    if (!cur) {
      cur = { ...(await api.createZone(body)), records: [] };
      changes.push({ op: 'create', kind: 'zone', name: z.name });
    } else if (
      cur.domain !== body.domain ||
      !cur.enabled ||
      [...cur.distribution_groups].sort().join() !== body.distribution_groups.join()
    ) {
      await api.updateZone(cur.id, body);
      changes.push({ op: 'update', kind: 'zone', name: z.name });
    }
    const recs = cur.records ?? [];
    for (const r of z.records) {
      const have = recs.find((x) => x.name === r.name && x.type === r.type);
      if (!have) {
        await api.createRecord(cur.id, r);
        changes.push({ op: 'create', kind: 'record', name: r.name });
      } else if (have.content !== r.content || have.ttl !== r.ttl) {
        await api.updateRecord(cur.id, have.id, r);
        changes.push({ op: 'update', kind: 'record', name: r.name });
      }
    }
    for (const have of recs) {
      if (!z.records.some((r) => r.name === have.name && r.type === have.type)) {
        await api.deleteRecord(cur.id, have.id);
        changes.push({ op: 'delete', kind: 'record', name: have.name });
      }
    }
  }

  // Deletions, reverse order, swarmy's namespace only.
  for (const z of zones) {
    if (isSwarmyManaged(c, z.name) && !plan.zones.some((w) => w.name === z.name)) {
      await api.deleteZone(z.id);
      changes.push({ op: 'delete', kind: 'zone', name: z.name });
    }
  }
  for (const p of policies) {
    if (!p.id || p.name === nodesPolicyName(c)) continue;
    if (isSwarmyManaged(c, p.name) && !plan.policies.some((w) => w.name === p.name)) {
      await api.deletePolicy(p.id);
      changes.push({ op: 'delete', kind: 'policy', name: p.name });
    }
  }
  for (const n of networks) {
    if (isSwarmyManaged(c, n.name) && !plan.networks.some((w) => w.name === n.name)) {
      await api.deleteNetwork(n.id);
      changes.push({ op: 'delete', kind: 'network', name: n.name });
    }
  }
  return { changes };
}

/** Delete swarmy groups for this cluster that nothing wants any more (after user sync). */
export async function pruneGroups(api: NetbirdAdminApi, plan: PeopleAccessPlan): Promise<SyncResult> {
  const changes: SyncChange[] = [];
  const keep = new Set([...plan.groups, nodesGroup(plan.cluster)]);
  for (const g of await api.listGroups()) {
    if (!g.name.startsWith(swarmyPrefix(plan.cluster)) || keep.has(g.name)) continue;
    try {
      await api.deleteGroup(g.id);
      changes.push({ op: 'delete', kind: 'group', name: g.name });
    } catch {
      // Still referenced (a user's auto_groups mid-change, a peer): next tick.
    }
  }
  return { changes };
}

/**
 * Bring NetBird's people in line with swarmy's members: each person gets
 * exactly their access/grant groups (their non-swarmy groups are kept), a
 * person who is no longer a member is blocked and their peers deleted.
 */
export async function applyUserSync(
  api: NetbirdAdminApi,
  args: { cluster: string; people: PersonAccess[] },
): Promise<SyncResult & { actions: UserSyncAction[] }> {
  const changes: SyncChange[] = [];
  const groups = await groupMap(api);
  for (const p of args.people) for (const g of p.groups) await ensureGroup(api, groups, g, changes);
  const nameOf = new Map([...groups.entries()].map(([n, id]) => [id, n]));
  const users = await api.listUsers();
  const actions = planUserSync({
    cluster: args.cluster,
    people: args.people,
    users: users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      isServiceUser: Boolean(u.is_service_user),
      isBlocked: u.is_blocked,
      idpId: u.idp_id,
      autoGroups: u.auto_groups.map((id) => nameOf.get(id) ?? id),
    })),
  });
  let peers: Awaited<ReturnType<NetbirdAdminApi['listPeersFull']>> | null = null;
  for (const a of actions) {
    const u = users.find((x) => x.id === a.nbUserId)!;
    await api.updateUser(a.nbUserId, {
      role: u.role || 'user',
      auto_groups: a.autoGroups.map((n) => groups.get(n) ?? n),
      is_blocked: a.block,
    });
    changes.push({ op: 'update', kind: 'user', name: a.email || a.nbUserId });
    if (a.deletePeers) {
      peers ??= await api.listPeersFull();
      for (const p of peers.filter((x) => x.user_id === a.nbUserId)) {
        await api.deletePeer(p.id);
        changes.push({ op: 'delete', kind: 'peer', name: p.name });
      }
    }
  }
  return { changes, actions };
}

/**
 * Register (or refresh) swarmy as the embedded IdP's one external connector.
 * Returns its id. The secret is re-sent on every call only when `rotate`.
 */
export async function ensureSwarmyConnector(
  api: NetbirdAdminApi,
  c: { name?: string; issuer: string; clientId: string; clientSecret?: string },
): Promise<{ id: string; created: boolean }> {
  const name = c.name ?? 'swarmy';
  const all = await api.listIdentityProviders();
  const cur = all.find((p) => p.name === name || p.client_id === c.clientId);
  if (cur) {
    if (c.clientSecret && (cur.issuer !== c.issuer || cur.client_id !== c.clientId)) {
      await api.updateIdentityProvider(cur.id, { type: 'oidc', name, issuer: c.issuer, client_id: c.clientId, client_secret: c.clientSecret });
    }
    return { id: cur.id, created: false };
  }
  if (!c.clientSecret) throw new Error('registering the swarmy connector needs the client secret');
  const created = await api.createIdentityProvider({ type: 'oidc', name, issuer: c.issuer, client_id: c.clientId, client_secret: c.clientSecret });
  return { id: created.id, created: true };
}

/** A person's device on the mesh (telemetry for "who's connected"). */
export interface PersonPeer {
  peerId: string;
  userId: string;
  email: string;
  name: string;
  device: string;
  os?: string;
  version?: string;
  meshIp: string;
  connected: boolean;
  lastSeen?: string;
  loginExpired: boolean;
  /** swarmy groups the peer is in (access/grant). */
  groups: string[];
}

/** People's peers (not server/router peers), with their swarmy groups. */
export async function listPeoplePeers(api: NetbirdAdminApi, cluster: string): Promise<PersonPeer[]> {
  const [users, peers] = await Promise.all([api.listUsers(), api.listPeersFull()]);
  const people = new Map(users.filter((u) => !u.is_service_user).map((u) => [u.id, u]));
  const prefix = swarmyPrefix(cluster);
  return peers
    .filter((p) => p.user_id && people.has(p.user_id))
    .map((p) => {
      const u = people.get(p.user_id!)!;
      return {
        peerId: p.id,
        userId: u.id,
        email: u.email,
        name: u.name,
        device: p.hostname || p.name,
        os: p.os,
        version: p.version,
        meshIp: p.ip,
        connected: p.connected,
        lastSeen: p.last_seen,
        loginExpired: Boolean(p.login_expired),
        groups: (p.groups ?? []).map((g) => g.name).filter((n) => n.startsWith(prefix)).sort(),
      };
    })
    .sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : a.device < b.device ? -1 : 1));
}
