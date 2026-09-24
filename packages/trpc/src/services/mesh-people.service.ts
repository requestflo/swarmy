/**
 * People on the mesh (plans/epic-self-hosted-mesh-and-fleets.md §3): swarmy's
 * grants → NetBird groups, Networks, policies and DNS zones, per stack.
 *
 * Inputs, all live or access control (no mirror table):
 *  - ABAC `mesh.connect` on each stack (`whoCan`), the rule path
 *  - `MeshRoute` rows of kind `person` (TTL'd personal grants), the grant path
 *  - live Docker inventory for the stack's services + declared ports
 *  - VIPs resolved by the stack's router over Docker DNS (never stored)
 * Output: `buildPeopleAccessPlan` (pure, golden-tested in @swarmy/mesh) applied
 * with `applyPeopleAccessPlan`, then `applyUserSync` (auto_groups per person;
 * leavers blocked + peers deleted), then routers down + groups pruned.
 *
 * People access is OFF until an admin turns it on (§9 pick 3); while off, the
 * plan is empty, every router is removed and every person loses their groups.
 */
import {
  NETBIRD_CLIENT_IMAGE_PINNED,
  accessGroup,
  applyPeopleAccessPlan,
  applyUserSync,
  buildPeopleAccessPlan,
  declaredPorts,
  grantGroup,
  listPeoplePeers,
  meshControlPublicUrl,
  pruneGroups,
  routerGroup,
  serviceFqdn,
  shortServiceName,
  type DeclaredPort,
  type NetbirdAdminApi,
  type PeopleAccessPlan,
  type PeopleStackIntent,
  type PersonAccess,
  type PersonPeer,
  type SyncChange,
} from '@swarmy/mesh';
import { STACK_LABEL, SYSTEM_STACK_LABEL } from '@swarmy/core';
import type { ApplyAccessRouterResult, SwarmServiceInfo } from '@swarmy/core/protocol';
import { TRPCError } from '@trpc/server';
import type { OrgContext } from '../context';
import { canPrincipal, resolveStackByName, whoCan } from '../abac';
import { writeAudit } from './audit.service';
import { meshConfigRepo } from './mesh-config.repo';
import { managedAdmin, managedOf, type ManagedControlPlane } from './mesh-control.service';

export interface PeopleAccessSettings {
  enabled: boolean;
  /** People's peers log in again after this long (plan §9 pick 3: 12 h). */
  loginExpiryHours: number;
}

const DEFAULTS: PeopleAccessSettings = { enabled: false, loginExpiryHours: 12 };

export function peopleSettings(settings: Record<string, unknown> | null | undefined): PeopleAccessSettings {
  const raw = (settings?.peopleAccess ?? {}) as Partial<PeopleAccessSettings>;
  return {
    enabled: raw.enabled === true,
    loginExpiryHours: typeof raw.loginExpiryHours === 'number' && raw.loginExpiryHours > 0 ? raw.loginExpiryHours : DEFAULTS.loginExpiryHours,
  };
}

// ── live stacks ──────────────────────────────────────────────────────────────

export interface LiveStack {
  name: string;
  services: SwarmServiceInfo[];
  /** The overlay the router joins (`<stack>_default`, else the stack's first own overlay). */
  network: string | null;
}

/** App stacks from live inventory (system stacks never get people access). */
export function liveStacks(services: readonly SwarmServiceInfo[]): LiveStack[] {
  const by = new Map<string, SwarmServiceInfo[]>();
  for (const s of services) {
    const stack = s.labels?.[STACK_LABEL];
    if (!stack || stack === 'swarmy' || s.labels?.[SYSTEM_STACK_LABEL] === 'true') continue;
    by.set(stack, [...(by.get(stack) ?? []), s]);
  }
  return [...by.entries()]
    .map(([name, svcs]) => {
      const nets = [...new Set(svcs.flatMap((s) => s.networks.map((n) => n.name)))].sort();
      const own = nets.filter((n) => n.startsWith(`${name}_`));
      const network = own.includes(`${name}_default`) ? `${name}_default` : (own[0] ?? null);
      return { name, services: [...svcs].sort((a, b) => (a.name < b.name ? -1 : 1)), network };
    })
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

function servicePorts(s: SwarmServiceInfo): DeclaredPort[] {
  return declaredPorts({ image: s.image, labels: s.labels, ports: s.ports.map((p) => ({ target: p.target, protocol: p.protocol })) });
}

// ── VIP cache: resolved by the stack's router, kept in memory ─────────────────

const vipCache = new Map<string, Record<string, string>>(); // `${orgId}/${stackId}` → fullName → vip

// ── the intent ──────────────────────────────────────────────────────────────

interface PersonGrantRow {
  id: string;
  principalId: string;
  targetStackId: string | null;
  targetServiceId: string | null;
  port: number | null;
  expiresAt: Date | null;
}

export interface PeopleIntentResult {
  cluster: string;
  stacks: (PeopleStackIntent & { network: string | null; rulePeople: string[] })[];
  people: PersonAccess[];
}

/** Everything that decides who reaches what, computed fresh (no writes). */
export async function computePeopleIntent(ctx: OrgContext, m: ManagedControlPlane, settings: PeopleAccessSettings): Promise<PeopleIntentResult> {
  const cluster = m.cluster;
  const members = (await ctx.db.member.findMany({
    where: { organizationId: ctx.activeOrgId },
    select: { userId: true, user: { select: { email: true } } },
  })) as { userId: string; user: { email: string | null } | null }[];
  const groupsOf = new Map<string, Set<string>>(members.map((mm) => [mm.userId, new Set<string>()]));
  const stacks: PeopleIntentResult['stacks'] = [];

  if (settings.enabled) {
    const now = new Date();
    const grants = (await ctx.db.meshRoute.findMany({
      where: { orgId: ctx.activeOrgId, kind: 'person' },
      select: { id: true, principalId: true, targetStackId: true, targetServiceId: true, port: true, expiresAt: true },
    })) as PersonGrantRow[];
    for (const st of liveStacks(ctx.hub.liveInventory(ctx.activeOrgId).services)) {
      const resource = await resolveStackByName(ctx, { stack: st.name });
      if (!resource) continue;
      const stackId = resource.id;
      const rows = await whoCan(ctx.db, ctx.activeOrgId, 'mesh.connect', resource);
      const rulePeople = rows.filter((r) => r.decision === 'permit').map((r) => r.userId);
      const stackGrants = grants.filter(
        (g) => (g.targetStackId === stackId || g.targetStackId === st.name) && (!g.expiresAt || g.expiresAt > now) && groupsOf.has(g.principalId),
      );
      const vips = vipCache.get(`${ctx.activeOrgId}/${stackId}`) ?? {};
      stacks.push({
        stackId,
        stackName: st.name,
        network: st.network,
        ruleAccess: rulePeople.length > 0,
        rulePeople,
        services: st.services.map((s) => ({ name: shortServiceName(st.name, s.name), vip: vips[s.name] ?? '', ports: servicePorts(s) })),
        grants: stackGrants.map((g) => ({ routeId: g.id, ports: g.port ? [g.port] : undefined, service: g.targetServiceId ?? undefined })),
      });
      for (const u of rulePeople) groupsOf.get(u)?.add(accessGroup(cluster, stackId));
      for (const g of stackGrants) groupsOf.get(g.principalId)?.add(grantGroup(cluster, g.id));
    }
  }
  const people = members.map((mm) => ({
    userId: mm.userId,
    email: mm.user?.email && !mm.user.email.endsWith('.swarmy.invalid') ? mm.user.email : null,
    groups: [...(groupsOf.get(mm.userId) ?? [])].sort(),
  }));
  return { cluster, stacks, people };
}

// ── routers ──────────────────────────────────────────────────────────────────

/** Where a stack's router runs now (live containers), if anywhere online. */
function routerNodes(ctx: OrgContext, stackId: string, nodeIds: string[]): string[] {
  return nodeIds.filter((n) =>
    ctx.hub.latestContainers(n).some((c) => c.labels?.['swarmy.role'] === 'access-router' && c.labels?.['swarmy.access.stack'] === stackId),
  );
}

async function onlineNodeIds(ctx: OrgContext): Promise<string[]> {
  const nodes = (await ctx.db.node.findMany({ where: { orgId: ctx.activeOrgId }, select: { id: true } })) as { id: string }[];
  return nodes.map((n) => n.id).filter((id) => ctx.hub.isOnline(id)).sort();
}

async function ensureGroupId(api: NetbirdAdminApi, name: string): Promise<string> {
  const g = (await api.listGroups()).find((x) => x.name === name);
  return g ? g.id : (await api.createGroup(name)).id;
}

/**
 * Bring up (or keep) the router of every stack that needs one and resolve its
 * services' VIPs through it. A stack whose router can't start (non-attachable
 * overlay) is reported, not retried every tick into a loop of errors.
 */
async function ensureRouters(
  ctx: OrgContext,
  api: NetbirdAdminApi,
  m: ManagedControlPlane,
  intent: PeopleIntentResult,
): Promise<{ steps: string[]; problems: Record<string, string> }> {
  const steps: string[] = [];
  const problems: Record<string, string> = {};
  const nodes = await onlineNodeIds(ctx);
  const managementUrl = meshControlPublicUrl(m.meshDomain, m.tls);
  const inv = liveStacks(ctx.hub.liveInventory(ctx.activeOrgId).services);
  for (const st of intent.stacks) {
    if (!st.ruleAccess && st.grants.length === 0) continue;
    if (!st.network) {
      problems[st.stackName] = 'this stack has no overlay network of its own';
      continue;
    }
    const svcNames = inv.find((s) => s.name === st.stackName)?.services.map((s) => s.name) ?? [];
    let placed = routerNodes(ctx, st.stackId, nodes);
    // Prefer the manager (stable), else the first online node.
    const target = placed[0] ?? ctx.hub.managerNode(ctx.activeOrgId) ?? nodes[0];
    if (!target) {
      problems[st.stackName] = 'no online node to run the router on';
      continue;
    }
    let setupKey: string | undefined;
    if (!placed.length) {
      const gid = await ensureGroupId(api, routerGroup(m.cluster, st.stackId));
      setupKey = (
        await api.createSetupKey({
          name: `swarmy router ${st.stackName}`,
          type: 'one-off',
          expires_in: 3600,
          auto_groups: [gid],
          usage_limit: 1,
          ephemeral: false,
        })
      ).key;
    }
    try {
      const r = await ctx.hub.dispatch<ApplyAccessRouterResult>(
        target,
        'mesh.accessRouter',
        { action: 'up', stackId: st.stackId, network: st.network, image: NETBIRD_CLIENT_IMAGE_PINNED, managementUrl, setupKey, resolve: svcNames },
        { timeoutMs: 90_000 },
      );
      if (r.error) {
        problems[st.stackName] = r.error;
        continue;
      }
      vipCache.set(`${ctx.activeOrgId}/${st.stackId}`, r.vips);
      for (const svc of st.services) {
        const full = `${st.stackName}_${svc.name}`;
        svc.vip = r.vips[full] ?? r.vips[svc.name] ?? svc.vip;
      }
      if (setupKey) {
        steps.push(`router up for ${st.stackName} on ${target}`);
        await writeAudit(ctx, { action: 'mesh.access.router.up', targetType: 'stack', targetId: st.stackId, metadata: { node: target, network: st.network } });
      }
      placed = [target];
    } catch (e) {
      problems[st.stackName] = e instanceof Error ? e.message : String(e);
    }
  }
  return { steps, problems };
}

/** Routers of stacks that no longer need one come down (and forget their peer). */
async function tearDownRouters(ctx: OrgContext, api: NetbirdAdminApi, plan: PeopleAccessPlan): Promise<string[]> {
  const steps: string[] = [];
  const keep = new Set(plan.networks.map((n) => n.routerGroup));
  const nodes = await onlineNodeIds(ctx);
  for (const n of nodes) {
    for (const c of ctx.hub.latestContainers(n)) {
      if (c.labels?.['swarmy.role'] !== 'access-router') continue;
      const stackId = c.labels['swarmy.access.stack'];
      if (!stackId || keep.has(routerGroup(plan.cluster, stackId))) continue;
      await ctx.hub.dispatch(n, 'mesh.accessRouter', { action: 'down', stackId, network: 'none' }, { timeoutMs: 60_000 }).catch(() => undefined);
      vipCache.delete(`${ctx.activeOrgId}/${stackId}`);
      steps.push(`router down for ${stackId}`);
      await writeAudit(ctx, { action: 'mesh.access.router.down', targetType: 'stack', targetId: stackId, metadata: { node: n } });
    }
  }
  // Router peers of removed routers: delete from NetBird so they don't linger.
  const peers = await api.listPeersFull().catch(() => []);
  for (const p of peers) {
    const names = (p.groups ?? []).map((g) => g.name);
    const router = names.find((g) => g.startsWith(`swarmy:${plan.cluster}:router:`));
    if (router && !keep.has(router) && !p.connected) await api.deletePeer(p.id).catch(() => undefined);
  }
  return steps;
}

// ── reconcile ────────────────────────────────────────────────────────────────

export interface PeopleReconcileResult {
  managed: boolean;
  enabled: boolean;
  changes: SyncChange[];
  steps: string[];
  problems: Record<string, string>;
}

let lastSignature = new Map<string, string>();

/**
 * One people-access tick (≤ 30 s, and on demand after a grant/revoke/toggle).
 * Removes expired personal grants first (the TTL sweeper), so expiry is enforced
 * within one tick.
 */
export async function reconcilePeopleAccess(ctx: OrgContext): Promise<PeopleReconcileResult> {
  const row = await meshConfigRepo.get(ctx, ctx.activeOrgId);
  const m = managedOf(row);
  const api = managedAdmin(row);
  const settings = peopleSettings(row.settings);
  if (!m || !api || !row.enabled) return { managed: false, enabled: settings.enabled, changes: [], steps: [], problems: {} };

  const steps: string[] = [];
  const expired = (await ctx.db.meshRoute.findMany({
    where: { orgId: ctx.activeOrgId, kind: 'person', expiresAt: { lt: new Date() } },
    select: { id: true, principalId: true, targetStackId: true },
  })) as { id: string; principalId: string; targetStackId: string | null }[];
  for (const g of expired) {
    await ctx.db.meshRoute.delete({ where: { id: g.id } });
    await writeAudit(ctx, { action: 'mesh.access.grant.expired', targetType: 'meshRoute', targetId: g.id, metadata: { userId: g.principalId, stack: g.targetStackId } });
    steps.push(`grant ${g.id} expired`);
  }

  const intent = await computePeopleIntent(ctx, m, settings);
  const routers = await ensureRouters(ctx, api, m, intent);
  steps.push(...routers.steps);
  const plan = buildPeopleAccessPlan({ cluster: intent.cluster, stacks: intent.stacks });
  const changes: SyncChange[] = [];
  changes.push(...(await applyPeopleAccessPlan(api, plan)).changes);
  changes.push(...(await applyUserSync(api, { cluster: intent.cluster, people: intent.people })).changes);
  steps.push(...(await tearDownRouters(ctx, api, plan)));
  changes.push(...(await pruneGroups(api, plan)).changes);

  if (changes.length) {
    const sig = JSON.stringify(changes);
    if (lastSignature.get(ctx.activeOrgId) !== sig) {
      await writeAudit(ctx, {
        action: 'mesh.access.sync',
        targetType: 'meshConfig',
        targetId: ctx.activeOrgId,
        metadata: { changes: changes.slice(0, 200), total: changes.length },
      });
    }
    lastSignature.set(ctx.activeOrgId, sig);
  }
  return { managed: true, enabled: settings.enabled, changes, steps, problems: routers.problems };
}

/** Test seam. */
export function resetPeopleCaches(): void {
  vipCache.clear();
  lastSignature = new Map();
}

// ── admin actions ────────────────────────────────────────────────────────────

async function requireManaged(ctx: OrgContext): Promise<{ m: ManagedControlPlane; api: NetbirdAdminApi }> {
  const row = await meshConfigRepo.get(ctx, ctx.activeOrgId);
  const m = managedOf(row);
  const api = managedAdmin(row);
  if (!m || !api) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'people access needs the mesh control plane that runs in swarmy' });
  return { m, api };
}

export async function setPeopleAccess(ctx: OrgContext, input: Partial<PeopleAccessSettings>): Promise<PeopleAccessSettings> {
  await requireManaged(ctx);
  const row = await meshConfigRepo.update(ctx, ctx.activeOrgId, (cur) => {
    const next = { ...peopleSettings(cur.settings), ...input };
    return { settings: { ...(cur.settings ?? {}), peopleAccess: next } };
  });
  const next = peopleSettings(row.settings);
  await writeAudit(ctx, { action: 'mesh.access.settings', targetType: 'meshConfig', targetId: ctx.activeOrgId, metadata: { ...next } });
  // The login expiry lives in NetBird's account settings (bootstrap), the rest in the next tick.
  const { api } = await requireManaged(ctx);
  const acct = await api.getAccount();
  if (acct.settings.peer_login_expiration !== next.loginExpiryHours * 3600) {
    await api.updateAccountSettings(acct.id, { ...acct.settings, peer_login_expiration: next.loginExpiryHours * 3600, peer_login_expiration_enabled: true });
  }
  void reconcilePeopleAccess(ctx).catch(() => undefined);
  return next;
}

export interface PersonGrantView {
  id: string;
  userId: string;
  stack: string | null;
  service: string | null;
  port: number | null;
  expiresAt: string | null;
  createdAt: string;
}

export async function grantPerson(
  ctx: OrgContext,
  input: { stack: string; userId: string; service?: string; port?: number; ttlSec?: number },
): Promise<PersonGrantView> {
  await requireManaged(ctx);
  const member = await ctx.db.member.findFirst({ where: { organizationId: ctx.activeOrgId, userId: input.userId }, select: { id: true } });
  if (!member) throw new TRPCError({ code: 'NOT_FOUND', message: 'that person is not a member of this organization' });
  const resource = await resolveStackByName(ctx, { stack: input.stack });
  if (!resource) throw new TRPCError({ code: 'NOT_FOUND', message: `stack ${input.stack} not found` });
  const expiresAt = input.ttlSec ? new Date(Date.now() + input.ttlSec * 1000) : null;
  const r = await ctx.db.meshRoute.create({
    data: {
      orgId: ctx.activeOrgId,
      kind: 'person',
      principalType: 'user',
      principalId: input.userId,
      targetStackId: resource.id,
      targetServiceId: input.service ?? null,
      port: input.port ?? null,
      expiresAt,
      createdById: ctx.user?.id ?? null,
    },
  });
  await writeAudit(ctx, {
    action: 'mesh.access.grant',
    targetType: 'meshRoute',
    targetId: r.id,
    metadata: { userId: input.userId, stack: input.stack, service: input.service ?? null, port: input.port ?? null, expiresAt: expiresAt?.toISOString() ?? null },
  });
  void reconcilePeopleAccess(ctx).catch(() => undefined);
  return toGrantView(r, input.stack);
}

function toGrantView(
  r: { id: string; principalId: string; targetStackId: string | null; targetServiceId: string | null; port: number | null; expiresAt: Date | null; createdAt: Date },
  stack?: string,
): PersonGrantView {
  return {
    id: r.id,
    userId: r.principalId,
    stack: stack ?? r.targetStackId,
    service: r.targetServiceId,
    port: r.port,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

export async function revokePersonGrant(ctx: OrgContext, grantId: string): Promise<void> {
  const r = await ctx.db.meshRoute.findFirst({ where: { id: grantId, orgId: ctx.activeOrgId, kind: 'person' } });
  if (!r) throw new TRPCError({ code: 'NOT_FOUND', message: 'grant not found' });
  await ctx.db.meshRoute.delete({ where: { id: r.id } });
  await writeAudit(ctx, { action: 'mesh.access.revoke', targetType: 'meshRoute', targetId: r.id, metadata: { userId: r.principalId, stack: r.targetStackId } });
  // Revocation is the case that must be fast: converge now, not on the next tick.
  await reconcilePeopleAccess(ctx).catch(() => undefined);
}

export async function listPersonGrants(ctx: OrgContext, stack?: string): Promise<PersonGrantView[]> {
  let stackId: string | undefined;
  if (stack) stackId = (await resolveStackByName(ctx, { stack }))?.id;
  const rows = await ctx.db.meshRoute.findMany({
    where: { orgId: ctx.activeOrgId, kind: 'person', ...(stackId ? { targetStackId: { in: [stackId, stack!] } } : {}) },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((r) => toGrantView(r as never, stack));
}

/** Disconnect a device now (admin): deletes the NetBird peer; the person signs in again. */
export async function revokePersonPeer(ctx: OrgContext, peerId: string): Promise<void> {
  const { m, api } = await requireManaged(ctx);
  const people = await listPeoplePeers(api, m.cluster);
  const p = people.find((x) => x.peerId === peerId);
  if (!p) throw new TRPCError({ code: 'NOT_FOUND', message: 'that device is not a person on this mesh' });
  await api.deletePeer(peerId);
  await writeAudit(ctx, { action: 'mesh.access.peer.revoke', targetType: 'meshPeer', targetId: peerId, metadata: { email: p.email, device: p.device } });
}

// ── views ────────────────────────────────────────────────────────────────────

export interface ConnectedPersonView extends Omit<PersonPeer, 'userId'> {
  netbirdUserId: string;
  /** Stacks (names) this device can reach now. */
  stacks: string[];
}

/** "Who's connected": people's devices (telemetry: NetBird peers + the stack map). */
export async function listConnectedPeople(ctx: OrgContext, opts: { stack?: string } = {}): Promise<ConnectedPersonView[]> {
  const row = await meshConfigRepo.get(ctx, ctx.activeOrgId);
  const m = managedOf(row);
  const api = managedAdmin(row);
  if (!m || !api) return [];
  const peers = await listPeoplePeers(api, m.cluster).catch(() => [] as PersonPeer[]);
  const stacks = liveStacks(ctx.hub.liveInventory(ctx.activeOrgId).services);
  const idToName = new Map<string, string>();
  for (const st of stacks) {
    const r = await resolveStackByName(ctx, { stack: st.name });
    if (r) idToName.set(r.id, st.name);
  }
  const grants = (await ctx.db.meshRoute.findMany({ where: { orgId: ctx.activeOrgId, kind: 'person' }, select: { id: true, targetStackId: true } })) as {
    id: string;
    targetStackId: string | null;
  }[];
  const grantStack = new Map(grants.map((g) => [g.id, g.targetStackId ? (idToName.get(g.targetStackId) ?? g.targetStackId) : null]));
  const out: ConnectedPersonView[] = [];
  for (const p of peers) {
    const reach = new Set<string>();
    for (const g of p.groups) {
      const parts = g.split(':'); // swarmy:<c>:<kind>:<id>
      if (parts[2] === 'access' && parts[3]) reach.add(idToName.get(parts[3]) ?? parts[3]);
      if (parts[2] === 'grant' && parts[3]) {
        const s = grantStack.get(parts[3]);
        if (s) reach.add(s);
      }
    }
    const { userId, ...rest } = p;
    const view = { ...rest, netbirdUserId: userId, stacks: [...reach].sort() };
    if (opts.stack && !view.stacks.includes(opts.stack)) continue;
    out.push(view);
  }
  return out;
}

export interface ConnectInfoView {
  available: boolean;
  /** Why not (people access off, no managed control plane). */
  reason?: string;
  managementUrl: string | null;
  /** One NetBird profile per cluster, so a work NetBird account is never clobbered. */
  profile: string | null;
  commands: { add: string; up: string } | null;
  allowed: boolean;
  /** Why the viewer may connect: the rule or the grant (with expiry). */
  via: { kind: 'rule' | 'grant'; detail: string; expiresAt?: string | null }[];
  services: { name: string; fqdn: string; ports: DeclaredPort[]; hint: string | null }[];
  /** When not allowed: who can grant access (admins/owners). */
  grantors: { name: string | null; email: string | null }[];
  loginExpiryHours: number;
}

function hintFor(fqdn: string, p: DeclaredPort | undefined, image: string): string | null {
  if (!p) return null;
  const img = image.toLowerCase();
  if (p.port === 5432 || /postgres/.test(img)) return `psql -h ${fqdn} -p ${p.port} -U postgres`;
  if (p.port === 6379 || /redis|valkey/.test(img)) return `redis-cli -h ${fqdn} -p ${p.port}`;
  if (p.port === 3306 || /mysql|mariadb/.test(img)) return `mysql -h ${fqdn} -P ${p.port} -u root -p`;
  if (p.port === 27017 || /mongo/.test(img)) return `mongosh mongodb://${fqdn}:${p.port}`;
  return `curl http://${fqdn}:${p.port}/`;
}

/** "Connect from your laptop" for one stack, for the person viewing it. */
export async function connectInfo(ctx: OrgContext, stack: string): Promise<ConnectInfoView> {
  const row = await meshConfigRepo.get(ctx, ctx.activeOrgId);
  const m = managedOf(row);
  const settings = peopleSettings(row.settings);
  const empty: ConnectInfoView = {
    available: false,
    managementUrl: null,
    profile: null,
    commands: null,
    allowed: false,
    via: [],
    services: [],
    grantors: [],
    loginExpiryHours: settings.loginExpiryHours,
  };
  if (!m || !row.enabled) return { ...empty, reason: 'The mesh control plane does not run in swarmy on this cluster.' };
  if (!settings.enabled) return { ...empty, reason: 'People access is off. An admin can turn it on in Networking → Mesh.' };
  const managementUrl = meshControlPublicUrl(m.meshDomain, m.tls);
  const profile = `swarmy-${m.cluster}`;
  const resource = await resolveStackByName(ctx, { stack });
  if (!resource) throw new TRPCError({ code: 'NOT_FOUND', message: `stack ${stack} not found` });
  const userId = ctx.user?.id;
  const via: ConnectInfoView['via'] = [];
  if (userId && (await canPrincipal(ctx.db, ctx.activeOrgId, userId, 'mesh.connect', resource))) {
    via.push({ kind: 'rule', detail: 'Your role and the access rules allow mesh.connect on this app.' });
  }
  const now = new Date();
  const grants = userId
    ? ((await ctx.db.meshRoute.findMany({
        where: { orgId: ctx.activeOrgId, kind: 'person', principalId: userId, targetStackId: { in: [resource.id, stack] } },
      })) as { targetServiceId: string | null; port: number | null; expiresAt: Date | null }[])
    : [];
  for (const g of grants) {
    if (g.expiresAt && g.expiresAt <= now) continue;
    via.push({
      kind: 'grant',
      detail: `Granted${g.targetServiceId ? ` for ${g.targetServiceId}` : ''}${g.port ? ` on port ${g.port}` : ''}`,
      expiresAt: g.expiresAt?.toISOString() ?? null,
    });
  }
  const live = liveStacks(ctx.hub.liveInventory(ctx.activeOrgId).services).find((s) => s.name === stack);
  const services = (live?.services ?? [])
    .map((s) => {
      const name = shortServiceName(stack, s.name);
      const ports = servicePorts(s);
      const fqdn = serviceFqdn(m.cluster, stack, name);
      return { name, fqdn, ports, hint: hintFor(fqdn, ports[0], s.image) };
    })
    .filter((s) => s.ports.length > 0);
  let grantors: ConnectInfoView['grantors'] = [];
  if (!via.length) {
    const admins = (await ctx.db.member.findMany({
      where: { organizationId: ctx.activeOrgId, role: { in: ['owner', 'admin'] } },
      select: { user: { select: { name: true, email: true } } },
    })) as { user: { name: string | null; email: string | null } | null }[];
    grantors = admins.map((a) => ({ name: a.user?.name ?? null, email: a.user?.email ?? null }));
  }
  return {
    available: true,
    managementUrl,
    profile,
    commands: {
      add: `netbird profile add ${profile}`,
      up: `netbird up --profile ${profile} --management-url ${managementUrl}`,
    },
    allowed: via.length > 0,
    via,
    services,
    grantors,
    loginExpiryHours: settings.loginExpiryHours,
  };
}

/** The Networking → Mesh people-access card. */
export async function getPeopleAccessCard(ctx: OrgContext): Promise<{
  managed: boolean;
  settings: PeopleAccessSettings;
  online: number;
  devices: number;
  identity: string;
  plan: PeopleAccessPlan | null;
}> {
  const row = await meshConfigRepo.get(ctx, ctx.activeOrgId);
  const m = managedOf(row);
  const settings = peopleSettings(row.settings);
  if (!m) return { managed: false, settings, online: 0, devices: 0, identity: '', plan: null };
  const people = await listConnectedPeople(ctx);
  const intent = await computePeopleIntent(ctx, m, settings).catch(() => null);
  return {
    managed: true,
    settings,
    online: people.filter((p) => p.connected).length,
    devices: people.length,
    identity: 'People sign in through swarmy (and any SSO it is set up with). NetBird never sees a password.',
    plan: intent ? buildPeopleAccessPlan({ cluster: intent.cluster, stacks: intent.stacks }) : null,
  };
}
