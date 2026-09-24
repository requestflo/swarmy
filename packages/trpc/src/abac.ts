import { stacks } from './services/apps.repo';
import { TRPCError } from '@trpc/server';
import {
  createEngine,
  defaultPolicyInputs,
  buildPrincipal as buildAbacPrincipal,
  buildResource as buildAbacResource,
  isAction,
  type Action,
  type GrantEdge,
  type IPolicyEngine,
  type Principal,
  type Relation,
  type Resource,
  type ResourceInput,
  type PolicyInput,
  ENV_LABEL,
  PRODUCTION,
  resourceEnv,
} from '@swarmy/abac';
import { buildInventory, STACK_LABEL } from '@swarmy/core';
import type { DB } from '@swarmy/db';
import { parse as parseYaml } from 'yaml';
import { orgProcedure } from './trpc';
import type { OrgContext } from './context';
import { writeAudit } from './services/audit.service';
import { defaultsDrift, policyRepo } from './services/policy-repo';

/**
 * Resolves the target resource for a procedure from its input. Returns a
 * {@link ResourceInput} (a plain row description) or `null` for collection /
 * instance-scoped actions (the resource is the org itself). The seam resolves
 * ReBAC relations from the org's grants — resolvers need not.
 */
export type ResolveResource = (
  ctx: OrgContext,
  input: unknown,
) => Promise<ResourceInput | null> | ResourceInput | null;

/** Pull a string[] team list out of a member's attribute bag, defensively. */
function teamIdsFromAttributes(attributes: Record<string, unknown> | null | undefined): string[] {
  const v = attributes?.teamIds;
  if (Array.isArray(v)) return v.map(String);
  return [];
}

type Role = 'owner' | 'admin' | 'member';

/** Build a principal from a `Member` row (role, id, attributes → groups/teams). */
export function principalFromMember(
  orgId: string,
  member: { id: string; userId: string; role: string; attributes: unknown },
): Principal {
  const attributes = (member.attributes as Record<string, unknown> | null) ?? {};
  const role: Role = member.role === 'owner' || member.role === 'admin' ? member.role : 'member';
  return buildAbacPrincipal({
    userId: member.userId,
    orgId,
    role,
    memberId: member.id,
    teamIds: teamIdsFromAttributes(attributes),
    attributes,
  });
}

/**
 * Build the ABAC principal from the org context: role, member id, groups (SSO
 * claims in `attributes.groups` ∪ team ids) and the free-form attribute bag
 * (all from the `Member` row). Roles become one attribute among many.
 */
export async function buildPrincipal(ctx: OrgContext): Promise<Principal> {
  const member = await ctx.db.member.findFirst({
    where: { organizationId: ctx.activeOrgId, userId: ctx.user.id },
    select: { id: true, role: true, attributes: true },
  });
  const attributes = (member?.attributes as Record<string, unknown> | undefined) ?? {};
  return buildAbacPrincipal({
    userId: ctx.user.id,
    orgId: ctx.activeOrgId,
    role: ctx.membership.role,
    memberId: member?.id ?? null,
    teamIds: teamIdsFromAttributes(attributes),
    attributes,
  });
}

/** Load the org's ResourceGrant edges for a single resource (ReBAC). */
async function loadGrants(db: DB, orgId: string, resource: ResourceInput): Promise<GrantEdge[]> {
  const rows = await db.resourceGrant.findMany({
    where: { orgId, resourceType: resource.type, resourceId: resource.id },
    select: { principalType: true, principalId: true, resourceType: true, resourceId: true, relation: true },
  });
  return rows.map((r) => ({
    principalType: r.principalType === 'team' ? 'team' : 'member',
    principalId: r.principalId,
    resourceType: r.resourceType,
    resourceId: r.resourceId,
    relation: r.relation as Relation,
  }));
}

/**
 * Load the org's enabled policies through the {@link policyRepo} (or fall back
 * to the seeded defaults) and build the engine.
 */
export async function loadPolicyEngine(db: DB, orgId: string): Promise<IPolicyEngine> {
  const repo = policyRepo(db);
  let all = await repo.list(orgId);
  // Defaults are managed (pre-launch, no back-compat): when the shipped set
  // changed, or an org has custom rows but no defaults, rewrite its stored
  // default rows. Best-effort — the decision below never depends on it.
  if (all.length > 0 && (defaultsDrift(all) || !all.some((r) => r.isDefault))) {
    try {
      if (await repo.ensureDefaults(orgId)) all = await repo.list(orgId);
    } catch {
      /* evaluate the shipped defaults in memory */
    }
  }
  // The engine always runs the SHIPPED default rules (stored default rows only
  // carry the admin's enable/disable and a real id for the audit trail) plus
  // the org's enabled custom rules.
  const storedDefaults = new Map(all.filter((r) => r.isDefault).map((r) => [r.name, r]));
  const defaults: PolicyInput[] = defaultPolicyInputs().map((p) => {
    const stored = storedDefaults.get(p.name);
    return {
      id: stored?.id ?? `default:${p.key}`,
      name: p.name,
      effect: p.effect,
      source: p.source,
      priority: p.priority,
      enabled: stored ? stored.enabled : true,
    };
  });
  const custom: PolicyInput[] = all
    .filter((r) => !r.isDefault && r.enabled)
    .map((r) => ({ id: r.id, name: r.name, effect: r.effect, source: r.source, priority: r.priority, enabled: true }));
  const inputs = [...defaults.filter((d) => d.enabled), ...custom];
  return createEngine(inputs);
}

export interface AccessResult {
  decision: 'permit' | 'deny';
  policyId: string | null;
  reasons: string[];
  resource: Resource | null;
}

/**
 * The one decision path. `evaluateAccess` (requests), `whoCan` (simulator,
 * mesh group sync) and `canPrincipal` all end here, so a rule means the same
 * thing everywhere. No audit — callers that enforce go through {@link authorize}.
 */
export async function decide(args: {
  db: DB;
  orgId: string;
  principal: Principal;
  action: Action;
  resource: ResourceInput | null;
  engine?: IPolicyEngine;
  userAgent?: string | null;
}): Promise<AccessResult> {
  const engine = args.engine ?? (await loadPolicyEngine(args.db, args.orgId));
  let resource: Resource | null = null;
  if (args.resource) {
    const grants = await loadGrants(args.db, args.orgId, args.resource);
    resource = buildAbacResource(args.resource, args.principal, grants);
  }
  const result = engine.evaluate({
    principal: args.principal,
    action: args.action,
    resource,
    context: { now: new Date(), ip: null, userAgent: args.userAgent ?? null },
  });
  return { ...result, resource };
}

/**
 * Evaluate one PARC request for the active org. Exposed so routers/services (e.g.
 * the policy simulator and list-filtering) can reuse the exact decision path.
 * `opts.principal` evaluates for someone else (the "who can" simulator);
 * `opts.engine` reuses an already-loaded policy set across many calls.
 */
export async function evaluateAccess(
  ctx: OrgContext,
  action: Action,
  resourceInput: ResourceInput | null,
  opts: { principal?: Principal; engine?: IPolicyEngine } = {},
): Promise<AccessResult> {
  const [principal, engine] = await Promise.all([
    opts.principal ?? buildPrincipal(ctx),
    opts.engine ?? loadPolicyEngine(ctx.db, ctx.activeOrgId),
  ]);
  return decide({
    db: ctx.db,
    orgId: ctx.activeOrgId,
    principal,
    action,
    resource: resourceInput,
    engine,
    userAgent: ctx.reqHeaders.get('user-agent'),
  });
}

export interface WhoCanRow {
  memberId: string;
  userId: string;
  name: string | null;
  email: string | null;
  role: Role;
  groups: string[];
  decision: 'permit' | 'deny';
  policyId: string | null;
  reasons: string[];
}

/**
 * "Who can do X on Y?" — every member of the org with their decision and the
 * deciding policy. Pure over the db (no request context, no audit), so the
 * policy simulator and a worker (e.g. the mesh NetBird group sync: one group
 * per app stack, `whoCan(db, orgId, 'mesh.connect', stackResource)`) share it.
 */
export async function whoCan(
  db: DB,
  orgId: string,
  action: Action,
  resource: ResourceInput | null,
): Promise<WhoCanRow[]> {
  const [engine, members] = await Promise.all([
    loadPolicyEngine(db, orgId),
    db.member.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        userId: true,
        role: true,
        attributes: true,
        user: { select: { name: true, email: true } },
      },
    }),
  ]);
  const rows: WhoCanRow[] = [];
  for (const m of members) {
    const principal = principalFromMember(orgId, m);
    const d = await decide({ db, orgId, principal, action, resource, engine });
    rows.push({
      memberId: m.id,
      userId: m.userId,
      name: m.user?.name ?? null,
      email: m.user?.email ?? null,
      role: principal.roles[0] as Role,
      groups: principal.groups ?? [],
      decision: d.decision,
      policyId: d.policyId,
      reasons: d.reasons,
    });
  }
  return rows;
}

/** One member's decision (by user id); `deny` when they are not a member. */
export async function canPrincipal(
  db: DB,
  orgId: string,
  userId: string,
  action: Action,
  resource: ResourceInput | null,
): Promise<boolean> {
  const m = await db.member.findFirst({
    where: { organizationId: orgId, userId },
    select: { id: true, userId: true, role: true, attributes: true },
  });
  if (!m) return false;
  const d = await decide({ db, orgId, principal: principalFromMember(orgId, m), action, resource });
  return d.decision === 'permit';
}

/**
 * The fine-grained enforcement seam. Built on `orgProcedure` (which guarantees an
 * authenticated member of the active org), it builds the PARC request, evaluates
 * the org's policies, and throws `FORBIDDEN` with `swarmyCode: 'POLICY_DENIED'`
 * (and the deciding policy id in `cause`) on deny. Every deny and every permit is
 * audited. On permit, ctx is augmented with `{ authz }` for downstream use.
 *
 * Pattern for wiring an existing procedure (do NOT edit other epics' routers
 * heavily — define a resolver next to the procedure and swap `orgProcedure` →
 * `abacProcedure(action, resolver)`):
 *
 * ```ts
 * import { abacProcedure, resolveService } from '@swarmy/trpc/abac';
 * restart: abacProcedure('service.restart', resolveService)
 *   .input(z.object({ id: z.string() }))
 *   .mutation(({ ctx, input }) => restartService(ctx, input.id)),
 * ```
 *
 * @param action one of the governed actions in `@swarmy/abac`.
 * @param resolveResource optional resolver mapping the procedure input → resource.
 */
export function abacProcedure(action: Action, resolveResource?: ResolveResource) {
  if (!isAction(action)) {
    throw new Error(`abacProcedure: unknown action "${action}"`);
  }
  return orgProcedure.use(async (opts) => {
    const ctx = opts.ctx as unknown as OrgContext;
    // This middleware sits BEFORE the procedure's `.input()`, so tRPC hands it no
    // parsed input — resolve from the raw input (resolvers read it defensively and
    // re-check existence with an org-scoped lookup).
    const input = resolveResource ? (opts.input ?? (await opts.getRawInput())) : undefined;
    const resourceInput = resolveResource ? await resolveResource(ctx, input) : null;
    const authz = await authorize(ctx, action, resourceInput);
    return opts.next({ ctx: { authz } });
  });
}

/**
 * {@link abacProcedure} over SEVERAL resources: the action must be permitted on
 * every one (each decision audited by `authorize`). For mutations that touch
 * two things at once, e.g. connecting a stack to a peer stack. A resolver that
 * returns null is skipped; the first deny throws.
 */
export function abacProcedureAll(action: Action, resolvers: ResolveResource[]) {
  if (!isAction(action)) {
    throw new Error(`abacProcedureAll: unknown action "${action}"`);
  }
  return orgProcedure.use(async (opts) => {
    const ctx = opts.ctx as unknown as OrgContext;
    const input = opts.input ?? (await opts.getRawInput());
    let authz: AuthzGrant | null = null;
    for (const resolve of resolvers) {
      const resourceInput = await resolve(ctx, input);
      if (!resourceInput) continue;
      authz = await authorize(ctx, action, resourceInput);
    }
    authz ??= await authorize(ctx, action, null);
    return opts.next({ ctx: { authz } });
  });
}

/** The `peer` stack of a two-stack mutation (`{ stack, peer }`). */
export const resolvePeerStack: ResolveResource = (ctx, input) => {
  const peer = (input as { peer?: unknown } | null)?.peer;
  return typeof peer === 'string' && peer ? resolveStackByName(ctx, { stack: peer }) : null;
};

/** What {@link authorize} returns on permit (also stamped on ctx by abacProcedure). */
export interface AuthzGrant {
  action: Action;
  decision: 'permit';
  policyId: string | null;
}

/**
 * The enforcement step shared by BOTH front doors: evaluate the PARC request,
 * audit the outcome (`authz.permit:<action>` / `authz.deny:<action>`), and throw
 * `FORBIDDEN` with `swarmyCode: 'POLICY_DENIED'` on deny. `abacProcedure` wraps
 * it for tRPC; the REST `requireAction` middleware calls it directly, so a
 * dashboard call and an API-key call get the identical decision + audit row.
 */
export async function authorize(
  ctx: OrgContext,
  action: Action,
  resourceInput: ResourceInput | null,
): Promise<AuthzGrant> {
  const result = await evaluateAccess(ctx, action, resourceInput);
  if (result.decision === 'deny') {
    await writeAudit(ctx, {
      action: `authz.deny:${action}`,
      targetType: result.resource?.type,
      targetId: result.resource?.id,
      metadata: { policyId: result.policyId, reasons: result.reasons },
    });
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `not permitted: ${action}`,
      cause: { swarmyCode: 'POLICY_DENIED', policyId: result.policyId },
    });
  }
  await writeAudit(ctx, {
    action: `authz.permit:${action}`,
    targetType: result.resource?.type,
    targetId: result.resource?.id,
    metadata: { policyId: result.policyId },
  });
  return { action, decision: 'permit', policyId: result.policyId };
}

// ── Documented resource resolvers for the common domain rows ────────────────
// These are the recommended, reusable resolvers other routers wire through. Each
// loads the org-scoped row (the org boundary stays the hard tenant gate) and maps
// it to a resource description; labels feed attribute policies.

/**
 * Resolve a Node from `{ id }` input. The org-scoped existence/identity check
 * stays on the kept Node enrollment row; labels are Docker-truth and come from
 * the live hub (no Node.labels column any more).
 */
export const resolveNode: ResolveResource = async (ctx, input) => {
  const id = (input as { id?: string })?.id;
  if (!id) return null;
  const row = await ctx.db.node.findFirst({
    where: { id, orgId: ctx.activeOrgId },
    select: { id: true, orgId: true },
  });
  // An id that doesn't resolve in THIS org is not "no resource" (which would
  // authorize against the org, i.e. as non-production) — it's not found.
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: `node ${id} not found` });
  const labels = ctx.hub.nodeInfoFor(row.id)?.labels ?? {};
  return { type: 'node', id: row.id, orgId: row.orgId, labels };
};

/**
 * Resolve a Service from `{ id }` input (Docker id or service name). There is no
 * Service model — the row is resolved from the live hub inventory, and the
 * service's Docker labels feed attribute policies.
 */
export const resolveService: ResolveResource = (ctx, input) => {
  const id = (input as { id?: string })?.id;
  if (!id) return null;
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  const svc = buildInventory(services, containers).services.find((s) => s.id === id || s.name === id);
  if (!svc) throw new TRPCError({ code: 'NOT_FOUND', message: `service ${id} not found` });
  return { type: 'service', id: svc.id, orgId: ctx.activeOrgId, labels: svc.labels };
};

/**
 * A stack's labels as Docker reports them: the union of its live services'
 * labels. Environment is conservative — if ANY service of the stack is
 * production, the stack is production.
 */
export function liveStackLabels(ctx: OrgContext, stackName: string): Record<string, string> | null {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  const members = buildInventory(services, containers).services.filter(
    (s) => s.labels?.[STACK_LABEL] === stackName,
  );
  if (members.length === 0) return null;
  const labels: Record<string, string> = {};
  for (const svc of members) Object.assign(labels, svc.labels);
  const envs = members.map((s) => resourceEnv({ labels: s.labels }));
  const prod = envs.find((e) => e === PRODUCTION);
  if (prod) labels[ENV_LABEL] = prod;
  return labels;
}

/** Labels declared in a compose document (service `labels` + `deploy.labels`). */
export function composeLabels(source: string): Record<string, string> {
  let doc: unknown;
  try {
    doc = parseYaml(source);
  } catch {
    return {};
  }
  const services = (doc as { services?: Record<string, unknown> } | null)?.services;
  if (!services || typeof services !== 'object') return {};
  const labelsOf = (raw: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        if (typeof entry !== 'string') continue;
        const i = entry.indexOf('=');
        if (i > 0) out[entry.slice(0, i)] = entry.slice(i + 1);
      }
    } else if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) if (v !== null && v !== undefined) out[k] = String(v);
    }
    return out;
  };
  const merged: Record<string, string> = {};
  let prod = false;
  for (const svc of Object.values(services)) {
    if (!svc || typeof svc !== 'object') continue;
    const s = svc as { labels?: unknown; deploy?: { labels?: unknown } };
    const own = { ...labelsOf(s.labels), ...labelsOf(s.deploy?.labels) };
    if (resourceEnv({ labels: own }) === PRODUCTION) prod = true;
    Object.assign(merged, own);
  }
  if (prod) merged[ENV_LABEL] = PRODUCTION;
  return merged;
}

/** The stack resource for a name: live labels, else the incoming compose's. */
async function stackResource(
  ctx: OrgContext,
  name: string,
  composeSource?: string,
): Promise<ResourceInput> {
  const row = await stacks(ctx, ctx.activeOrgId).findFirst({
    where: { name, orgId: ctx.activeOrgId },
    select: { id: true },
  });
  const live = liveStackLabels(ctx, name);
  const incoming = composeSource ? composeLabels(composeSource) : {};
  const labels = { ...incoming, ...(live ?? {}) };
  // A deploy that STAMPS production counts as production immediately.
  if (resourceEnv({ labels: incoming }) === PRODUCTION) labels[ENV_LABEL] = PRODUCTION;
  return { type: 'stack', id: row?.id ?? name, orgId: ctx.activeOrgId, labels };
}

/** Resolve a Stack row from `{ id }` input; labels are the live stack's. */
export const resolveStack: ResolveResource = async (ctx, input) => {
  const id = (input as { id?: string })?.id;
  if (!id) return null;
  const row = await stacks(ctx, ctx.activeOrgId).findFirst({
    where: { id, orgId: ctx.activeOrgId },
    select: { id: true, orgId: true, name: true },
  });
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: `stack ${id} not found` });
  const composeSource = (input as { composeSource?: unknown }).composeSource;
  const r = await stackResource(ctx, row.name, typeof composeSource === 'string' ? composeSource : undefined);
  return { ...r, id: row.id, orgId: row.orgId };
};

/**
 * Resolve a stack by NAME from `{ name | stack, composeSource? }` — deploys that
 * may create the stack. Env comes from the live stack or the incoming compose.
 */
export const resolveStackByName: ResolveResource = async (ctx, input) => {
  const i = (input ?? {}) as { name?: unknown; stack?: unknown; composeSource?: unknown };
  const name = typeof i.stack === 'string' ? i.stack : typeof i.name === 'string' ? i.name : null;
  if (!name) return null;
  return stackResource(ctx, name, typeof i.composeSource === 'string' ? i.composeSource : undefined);
};

/**
 * Resolve a service that is about to be CREATED from `{ name, project? }`: it
 * inherits its project (stack) labels, so "members can't deploy to prod"
 * covers adding an app to a production stack.
 */
export const resolveNewService: ResolveResource = async (ctx, input) => {
  const i = (input ?? {}) as { name?: unknown; project?: unknown };
  const name = typeof i.name === 'string' ? i.name : null;
  if (!name) return null;
  const labels = typeof i.project === 'string' ? (liveStackLabels(ctx, i.project) ?? {}) : {};
  return { type: 'service', id: name, orgId: ctx.activeOrgId, labels };
};

/**
 * Resolve the APP service a managed-data mutation wires (`{ stack, appService }`
 * — inject/attach/detach). The service is looked up live by id, name, or its
 * stack-qualified name (`<stack>_<appService>`); when it is not running yet the
 * stack itself stands in (its live labels), so a production stack's app is
 * never judged as "no resource".
 */
export const resolveStackService: ResolveResource = async (ctx, input) => {
  const i = (input ?? {}) as { stack?: unknown; appService?: unknown };
  const stack = typeof i.stack === 'string' && i.stack ? i.stack : null;
  const app = typeof i.appService === 'string' && i.appService ? i.appService : null;
  if (app) {
    const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
    const all = buildInventory(services, containers).services;
    // Stack-qualified first: a same-named service in ANOTHER stack must not
    // stand in for the one this mutation actually touches.
    const svc =
      (stack ? all.find((s) => s.name === `${stack}_${app}`) : undefined) ??
      all.find((s) => s.id === app || s.name === app);
    if (svc) return { type: 'service', id: svc.id, orgId: ctx.activeOrgId, labels: svc.labels };
  }
  return stack ? stackResource(ctx, stack) : null;
};
