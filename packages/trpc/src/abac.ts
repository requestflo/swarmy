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
} from '@swarmy/abac';
import { buildInventory } from '@swarmy/core';
import { orgProcedure } from './trpc';
import type { OrgContext } from './context';
import { writeAudit } from './services/audit.service';

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

/**
 * Build the ABAC principal from the org context: role, member id, team ids and
 * the free-form attribute bag (all from the `Member` row). Roles become one
 * attribute among many.
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
async function loadGrants(ctx: OrgContext, resource: ResourceInput): Promise<GrantEdge[]> {
  const rows = await ctx.db.resourceGrant.findMany({
    where: { orgId: ctx.activeOrgId, resourceType: resource.type, resourceId: resource.id },
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

/** Load the org's enabled policies (or fall back to the seeded defaults). */
async function loadEngine(ctx: OrgContext): Promise<IPolicyEngine> {
  const rows = await ctx.db.policy.findMany({
    where: { orgId: ctx.activeOrgId, enabled: true },
  });
  const inputs: PolicyInput[] =
    rows.length === 0
      ? // No stored policies → behave exactly as the seeded defaults.
        defaultPolicyInputs().map(
          (p): PolicyInput => ({
            id: `default:${p.key}`,
            name: p.name,
            effect: p.effect,
            source: p.source,
            priority: p.priority,
            enabled: true,
          }),
        )
      : rows.map(
          (r): PolicyInput => ({
            id: r.id,
            name: r.name,
            effect: r.effect as PolicyInput['effect'],
            source: r.source,
            priority: r.priority,
            enabled: r.enabled,
          }),
        );
  return createEngine(inputs);
}

/**
 * Evaluate one PARC request for the active org. Exposed so routers/services (e.g.
 * the policy simulator and list-filtering) can reuse the exact decision path.
 */
export async function evaluateAccess(
  ctx: OrgContext,
  action: Action,
  resourceInput: ResourceInput | null,
): Promise<{ decision: 'permit' | 'deny'; policyId: string | null; reasons: string[]; resource: Resource | null }> {
  const [principal, engine] = await Promise.all([buildPrincipal(ctx), loadEngine(ctx)]);
  let resource: Resource | null = null;
  if (resourceInput) {
    const grants = await loadGrants(ctx, resourceInput);
    resource = buildAbacResource(resourceInput, principal, grants);
  }
  const result = engine.evaluate({
    principal,
    action,
    resource,
    context: { now: new Date(), ip: null, userAgent: ctx.reqHeaders.get('user-agent') },
  });
  return { ...result, resource };
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
    const resourceInput = resolveResource ? await resolveResource(ctx, opts.input) : null;
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

    return opts.next({
      ctx: { authz: { action, decision: result.decision, policyId: result.policyId } },
    });
  });
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
  if (!row) return null;
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
  if (!svc) return null;
  return { type: 'service', id: svc.id, orgId: ctx.activeOrgId, labels: svc.labels };
};

/** Resolve a Stack row from `{ id }` input. */
export const resolveStack: ResolveResource = async (ctx, input) => {
  const id = (input as { id?: string })?.id;
  if (!id) return null;
  const row = await ctx.db.stack.findFirst({
    where: { id, orgId: ctx.activeOrgId },
    select: { id: true, orgId: true },
  });
  if (!row) return null;
  return { type: 'stack', id: row.id, orgId: row.orgId, labels: {} };
};
