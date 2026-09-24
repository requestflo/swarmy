/**
 * People on the mesh (plans/epic-self-hosted-mesh-and-fleets.md §3): swarmy's
 * grants rendered into NetBird objects. Everything here is PURE and golden-
 * tested — names are deterministic functions of the cluster slug + stack id, so
 * a render is stable and a diff against NetBird touches only swarmy's own
 * `swarmy:<c>:*` namespace.
 *
 *   group    swarmy:<c>:nodes               server peers (setup keys)
 *   group    swarmy:<c>:access:<stackId>    people allowed on a stack (ABAC mesh.connect)
 *   group    swarmy:<c>:grant:<routeId>     a TTL'd personal grant (MeshRoute kind=person)
 *   group    swarmy:<c>:router:<stackId>    the stack's routing peer(s)
 *   group    swarmy:<c>:res:<stackId>       the stack's resources (NetBird needs a group)
 *   network  swarmy-<c>-<stackId>           routing peers = router group, masquerade
 *   resource <svc>                          service VIP /32
 *   policy   swarmy-<c>-<stackId>-<svc>     access (+ grant) groups → resource, declared ports
 *   zone     <stack>.<c>.swarmy.internal    distributed only to that stack's access + grant groups
 *
 * Default deny holds by construction: no policy ever names `nodes` as a
 * destination for a people group, and only services with declared ports become
 * resources.
 */

// ── names ───────────────────────────────────────────────────────────────────

/** Every NetBird object swarmy owns starts with this (per cluster). */
export function swarmyPrefix(cluster: string): string {
  return `swarmy:${cluster}:`;
}
export function nodesGroup(cluster: string): string {
  return `swarmy:${cluster}:nodes`;
}
export function accessGroup(cluster: string, stackId: string): string {
  return `swarmy:${cluster}:access:${stackId}`;
}
export function grantGroup(cluster: string, routeId: string): string {
  return `swarmy:${cluster}:grant:${routeId}`;
}
export function routerGroup(cluster: string, stackId: string): string {
  return `swarmy:${cluster}:router:${stackId}`;
}
export function resourceGroup(cluster: string, stackId: string): string {
  return `swarmy:${cluster}:res:${stackId}`;
}
/** Networks, policies and zones can't hold ':' in every client, so they use '-'. */
export function networkName(cluster: string, stackId: string): string {
  return `swarmy-${cluster}-${stackId}`;
}
export function policyName(cluster: string, stackId: string, service: string): string {
  return `swarmy-${cluster}-${stackId}-${service}`;
}
/** The nodes ↔ nodes policy the bootstrap creates. */
export function nodesPolicyName(cluster: string): string {
  return `swarmy-${cluster}-nodes`;
}
export function zoneName(cluster: string, stackId: string): string {
  return `swarmy-${cluster}-${stackId}`;
}
/** True for any object name swarmy manages for this cluster. */
export function isSwarmyManaged(cluster: string, name: string): boolean {
  return name.startsWith(swarmyPrefix(cluster)) || name.startsWith(`swarmy-${cluster}-`);
}

/** DNS-safe label: lowercase, [a-z0-9-], trimmed to 63. */
export function dnsLabel(s: string): string {
  const l = s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
  return l || 'x';
}
export function clusterDomain(cluster: string): string {
  return `${dnsLabel(cluster)}.swarmy.internal`;
}
export function stackDomain(cluster: string, stackName: string): string {
  return `${dnsLabel(stackName)}.${clusterDomain(cluster)}`;
}
/** `db.storefront.lon.swarmy.internal` — the FQDN the UI hands out (spike §11.6). */
export function serviceFqdn(cluster: string, stackName: string, service: string): string {
  return `${dnsLabel(service)}.${stackDomain(cluster, stackName)}`;
}

/** The short service name inside a stack (`storefront_db` → `db`). */
export function shortServiceName(stackName: string, serviceName: string): string {
  const p = `${stackName}_`;
  return serviceName.startsWith(p) ? serviceName.slice(p.length) : serviceName;
}

// ── declared ports ──────────────────────────────────────────────────────────

export interface DeclaredPort {
  port: number;
  proto: 'tcp' | 'udp';
}

/** The facts about a live service that decide which ports people may reach. */
export interface PortFacts {
  image?: string;
  labels?: Record<string, string>;
  /** Published ports (targets are what the service listens on). */
  ports?: { target: number; protocol?: 'tcp' | 'udp' }[];
}

/** Explicit override: `swarmy.mesh.ports=5432,8080/tcp,53/udp`. */
export const MESH_PORTS_LABEL = 'swarmy.mesh.ports';

const ENGINE_PORTS: Record<string, number> = {
  postgres: 5432,
  postgresql: 5432,
  mysql: 3306,
  mariadb: 3306,
  mongo: 27017,
  mongodb: 27017,
  redis: 6379,
  valkey: 6379,
  keydb: 6379,
  dragonfly: 6379,
  clickhouse: 8123,
  meilisearch: 7700,
  typesense: 8108,
  elasticsearch: 9200,
  opensearch: 9200,
  qdrant: 6333,
  rabbitmq: 5672,
  nats: 4222,
  minio: 9000,
};

function parsePortList(raw: string): DeclaredPort[] {
  const out: DeclaredPort[] = [];
  for (const part of raw.split(/[\s,]+/).filter(Boolean)) {
    const m = /^(\d{1,5})(?:\/(tcp|udp))?$/i.exec(part);
    if (!m) continue;
    const port = Number(m[1]);
    if (port < 1 || port > 65535) continue;
    out.push({ port, proto: (m[2]?.toLowerCase() as 'tcp' | 'udp') ?? 'tcp' });
  }
  return out;
}

function imageEngine(image: string | undefined): string | undefined {
  if (!image) return undefined;
  const repo = image.split('@')[0]!.split(':')[0]!.split('/').pop() ?? '';
  const base = repo.toLowerCase();
  if (ENGINE_PORTS[base] !== undefined) return base;
  // bitnami/postgresql, pgvector/pgvector, timescale/timescaledb, …
  if (/postgres|pgvector|timescale|postgis/.test(base)) return 'postgres';
  return undefined;
}

function uniqSorted(ports: DeclaredPort[]): DeclaredPort[] {
  const seen = new Map<string, DeclaredPort>();
  for (const p of ports) seen.set(`${p.proto}/${p.port}`, p);
  return [...seen.values()].sort((a, b) => a.port - b.port || (a.proto < b.proto ? -1 : 1));
}

/**
 * The ports of a service people may reach. First match wins:
 *  1. `swarmy.mesh.ports` (explicit; an empty value means "none")
 *  2. swarmy managed-data engine labels (`swarmy.db.engine`, `swarmy.cache.engine`, …)
 *  3. ingress route ports (`swarmy.ingress.routes` JSON) ∪ published targets
 *  4. the well-known port of a recognised database/cache image
 * Nothing matched ⇒ no ports ⇒ the service is not a resource (default deny).
 */
export function declaredPorts(facts: PortFacts): DeclaredPort[] {
  const labels = facts.labels ?? {};
  if (MESH_PORTS_LABEL in labels) return uniqSorted(parsePortList(labels[MESH_PORTS_LABEL] ?? ''));

  for (const key of ['swarmy.db.engine', 'swarmy.cache.engine', 'swarmy.search.engine', 'swarmy.vector.engine']) {
    const engine = labels[key]?.toLowerCase();
    if (engine && ENGINE_PORTS[engine] !== undefined) return [{ port: ENGINE_PORTS[engine]!, proto: 'tcp' }];
  }

  const found: DeclaredPort[] = [];
  const routes = labels['swarmy.ingress.routes'];
  if (routes) {
    try {
      const parsed = JSON.parse(routes) as unknown;
      for (const r of Array.isArray(parsed) ? parsed : []) {
        const port = (r as { port?: unknown })?.port;
        if (typeof port === 'number' && port >= 1 && port <= 65535) found.push({ port, proto: 'tcp' });
      }
    } catch {
      /* not JSON — ignore */
    }
  }
  for (const p of facts.ports ?? []) found.push({ port: p.target, proto: p.protocol ?? 'tcp' });
  if (found.length) return uniqSorted(found);

  const engine = imageEngine(facts.image);
  return engine ? [{ port: ENGINE_PORTS[engine]!, proto: 'tcp' }] : [];
}

// ── the access intent and its plan ─────────────────────────────────────────

export interface PeopleServiceIntent {
  /** Short service name inside the stack (`db`). */
  name: string;
  /** Service VIP on the stack overlay (read live, never stored). */
  vip: string;
  ports: DeclaredPort[];
}

export interface PersonalGrantIntent {
  /** `MeshRoute.id` (kind = person). */
  routeId: string;
  /** Restrict to these ports (empty ⇒ all the service's declared ports). */
  ports?: number[];
  /** Restrict to one service (short name); absent ⇒ every service of the stack. */
  service?: string;
}

export interface PeopleStackIntent {
  stackId: string;
  stackName: string;
  services: PeopleServiceIntent[];
  /** Is there anybody allowed by rule (ABAC mesh.connect)? Drives the access group. */
  ruleAccess: boolean;
  grants: PersonalGrantIntent[];
}

export interface PeopleAccessIntent {
  cluster: string;
  stacks: PeopleStackIntent[];
}

export interface PlannedNetwork {
  name: string;
  description: string;
  routerGroup: string;
  resources: { name: string; address: string; group: string }[];
}

export interface PlannedPolicy {
  name: string;
  /** Source group names (access and/or grant groups). */
  sources: string[];
  /** Destination resource: `<network>/<resource>`. */
  network: string;
  resource: string;
  protocol: 'tcp' | 'udp';
  ports: string[];
}

export interface PlannedZone {
  name: string;
  domain: string;
  distributionGroups: string[];
  records: { name: string; type: 'A'; content: string; ttl: number }[];
}

export interface PeopleAccessPlan {
  cluster: string;
  groups: string[];
  networks: PlannedNetwork[];
  policies: PlannedPolicy[];
  zones: PlannedZone[];
}

const byName = <T extends { name: string }>(a: T, b: T): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}$/;

/**
 * Render the NetBird objects for people access. A stack with no rule access and
 * no grants renders nothing (its router is removed); a service without a VIP or
 * declared ports is not a resource. Sorted everywhere → stable goldens.
 */
export function buildPeopleAccessPlan(intent: PeopleAccessIntent): PeopleAccessPlan {
  const c = intent.cluster;
  const groups = new Set<string>();
  const networks: PlannedNetwork[] = [];
  const policies: PlannedPolicy[] = [];
  const zones: PlannedZone[] = [];

  const stacks = [...intent.stacks].sort((a, b) => (a.stackId < b.stackId ? -1 : 1));
  for (const st of stacks) {
    const grants = [...st.grants].sort((a, b) => (a.routeId < b.routeId ? -1 : 1));
    if (!st.ruleAccess && grants.length === 0) continue;
    const services = st.services
      .filter((s) => IPV4.test(s.vip) && s.ports.length > 0)
      .sort(byName);

    const access = accessGroup(c, st.stackId);
    const router = routerGroup(c, st.stackId);
    const res = resourceGroup(c, st.stackId);
    const net = networkName(c, st.stackId);
    groups.add(router);
    groups.add(res);
    if (st.ruleAccess) groups.add(access);
    for (const g of grants) groups.add(grantGroup(c, g.routeId));

    networks.push({
      name: net,
      description: `swarmy stack ${st.stackName}`,
      routerGroup: router,
      resources: services.map((s) => ({ name: s.name, address: `${s.vip}/32`, group: res })),
    });

    for (const svc of services) {
      for (const proto of ['tcp', 'udp'] as const) {
        const svcPorts = svc.ports.filter((p) => p.proto === proto).map((p) => p.port);
        if (!svcPorts.length) continue;
        // Rule access reaches every declared port; a grant may narrow it.
        const bySet = new Map<string, string[]>();
        const add = (source: string, ports: number[]): void => {
          const key = [...new Set(ports)].sort((a, b) => a - b).join(',');
          if (!key) return;
          bySet.set(key, [...(bySet.get(key) ?? []), source]);
        };
        if (st.ruleAccess) add(access, svcPorts);
        for (const g of grants) {
          if (g.service && g.service !== svc.name) continue;
          const allowed = g.ports?.length ? svcPorts.filter((p) => g.ports!.includes(p)) : svcPorts;
          add(grantGroup(c, g.routeId), allowed);
        }
        const sets = [...bySet.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
        sets.forEach(([key, sources], i) => {
          const base = policyName(c, st.stackId, svc.name);
          const suffix = (proto === 'udp' ? '-udp' : '') + (i > 0 ? `-${i}` : '');
          policies.push({
            name: base + suffix,
            sources: [...sources].sort(),
            network: net,
            resource: svc.name,
            protocol: proto,
            ports: key.split(','),
          });
        });
      }
    }

    const dist = [...(st.ruleAccess ? [access] : []), ...grants.map((g) => grantGroup(c, g.routeId))].sort();
    zones.push({
      name: zoneName(c, st.stackId),
      domain: stackDomain(c, st.stackName),
      distributionGroups: dist,
      records: services
        .map((s) => ({ name: serviceFqdn(c, st.stackName, s.name), type: 'A' as const, content: s.vip, ttl: 60 }))
        .sort(byName),
    });
  }

  return {
    cluster: c,
    groups: [...groups].sort(),
    networks: networks.sort(byName),
    policies: policies.sort(byName),
    zones: zones.sort(byName),
  };
}

/** Stacks that need a routing peer (a network in the plan). */
export function routerStacks(plan: PeopleAccessPlan): string[] {
  const prefix = `swarmy-${plan.cluster}-`;
  return plan.networks.map((n) => n.name.slice(prefix.length)).sort();
}

// ── user sync ───────────────────────────────────────────────────────────────

/** A NetBird user as the Admin API reports it (the fields sync reads). */
export interface NbUserFacts {
  id: string;
  email: string;
  name?: string;
  isServiceUser: boolean;
  isBlocked: boolean;
  autoGroups: string[]; // group NAMES (resolved by the caller)
  /** `local` for the break-glass owner, else the connector id. */
  idpId?: string;
  role?: string;
  /** The IdP subject (swarmy user id) decoded from the Dex user id, when known. */
  subject?: string;
}

/**
 * NetBird's embedded Dex names a user `base64(proto{1: sub, 2: connectorId})`
 * (seen live: the break-glass owner is `CiQ…EgVsb2NhbA` = sub + "local"). For
 * people who sign in through swarmy, `sub` IS the swarmy user id — a sturdier
 * match than email (username-only accounts carry no email claim). Pure.
 */
export function dexSubject(nbUserId: string): { sub: string; connector: string } | null {
  let buf: Uint8Array;
  try {
    buf = Uint8Array.from(atob(nbUserId.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  const fields: Record<number, string> = {};
  let i = 0;
  const dec = new TextDecoder('utf-8', { fatal: true });
  while (i < buf.length) {
    const tag = buf[i++]!;
    const field = tag >> 3;
    if ((tag & 7) !== 2 || field < 1 || field > 2) return null;
    let len = 0;
    let shift = 0;
    for (;;) {
      if (i >= buf.length) return null;
      const b = buf[i++]!;
      len |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
      if (shift > 28) return null;
    }
    if (i + len > buf.length) return null;
    try {
      fields[field] = dec.decode(buf.subarray(i, i + len));
    } catch {
      return null;
    }
    i += len;
  }
  return fields[1] && fields[2] ? { sub: fields[1], connector: fields[2] } : null;
}

/** A swarmy member and the swarmy groups they should be in. */
export interface PersonAccess {
  userId: string;
  email: string | null;
  /** Access + grant group names. Empty when people access is off. */
  groups: string[];
}

export interface UserSyncAction {
  nbUserId: string;
  email: string;
  /** New auto_groups (NAMES): the user's non-swarmy groups kept, swarmy's replaced. */
  autoGroups: string[];
  block: boolean;
  /** Also delete this user's peers (they left the org or were disabled). */
  deletePeers: boolean;
  swarmyUserId: string | null;
}

/**
 * Decide what each NetBird person should look like. Matches on the Dex
 * subject (the swarmy user id, see {@link dexSubject}), else email (lowercase). Service users and the local break-glass owner are never touched.
 * A person with no matching swarmy member is blocked and loses their peers;
 * a matching member gets exactly their swarmy groups (others preserved) and is
 * unblocked. Only users that need a change are returned. Pure.
 */
export function planUserSync(args: { cluster: string; users: NbUserFacts[]; people: PersonAccess[] }): UserSyncAction[] {
  const prefix = swarmyPrefix(args.cluster);
  const byEmail = new Map<string, PersonAccess>();
  const byId = new Map<string, PersonAccess>();
  for (const p of args.people) {
    byId.set(p.userId, p);
    if (p.email) byEmail.set(p.email.toLowerCase(), p);
  }
  const out: UserSyncAction[] = [];
  const users = [...args.users].sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const u of users) {
    if (u.isServiceUser || u.idpId === 'local' || u.role === 'owner') continue;
    const sub = u.subject ?? dexSubject(u.id)?.sub;
    const person = (sub ? byId.get(sub) : undefined) ?? (u.email ? byEmail.get(u.email.toLowerCase()) : undefined);
    const kept = u.autoGroups.filter((g) => !g.startsWith(prefix));
    const current = [...u.autoGroups].sort();
    if (!person) {
      const next = [...kept].sort();
      if (u.isBlocked && sameList(current, next)) continue;
      out.push({ nbUserId: u.id, email: u.email, autoGroups: next, block: true, deletePeers: true, swarmyUserId: null });
      continue;
    }
    const next = [...new Set([...kept, ...person.groups])].sort();
    if (!u.isBlocked && sameList(current, next)) continue;
    out.push({ nbUserId: u.id, email: u.email, autoGroups: next, block: false, deletePeers: false, swarmyUserId: person.userId });
  }
  return out;
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
