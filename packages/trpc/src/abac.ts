import { TRPCError } from '@trpc/server';
import {
  PolicyEngine,
  isAction,
  type Action,
  type Principal,
  type Resource,
  type PolicyInput,
} from '@swarmy/abac';
import { orgProcedure } from './trpc';
import type { OrgContext } from './context';
import { writeAudit } from './services/audit.service';

/**
 * Resolves the target resource for a procedure from its input. Returns `null`
 * for collection/instance-scoped actions (the resource is the org itself).
 */
export type ResolveResource = (
  ctx: OrgContext,
  input: unknown,
) => Promise<Resource | null> | Resource | null;

/** Build the ABAC principal from the org context (membership + attributes). */
export async function buildPrincipal(ctx: OrgContext): Promise<Principal> {
  const member = await ctx.db.member.findFirst({
    where: { organizationId: ctx.activeOrgId, userId: ctx.user.id },
    select: { id: true, role: true },
  });
  // Member.attributes is optional (added by this epic). Read defensively so the
  // package compiles whether or not the column has been pushed yet.
  const attributes =
    ((member as { attributes?: Record<string, unknown> } | null)?.attributes as
      | Record<string, unknown>
      | undefined) ?? {};
  return {
    userId: ctx.user.id,
    orgId: ctx.activeOrgId,
    roles: [ctx.membership.role],
    attributes: { memberId: member?.id, ...attributes },
  };
}

/** Load the org's enabled policies (or fall back to the seeded defaults). */
async function loadEngine(ctx: OrgContext): Promise<PolicyEngine> {
  const rows = await ctx.db.policy.findMany({
    where: { orgId: ctx.activeOrgId, enabled: true },
  });
  if (rows.length === 0) return PolicyEngine.withDefaults();
  return new PolicyEngine(
    rows.map(
      (r): PolicyInput => ({
        id: r.id,
        name: r.name,
        effect: r.effect as PolicyInput['effect'],
        source: r.source,
        priority: r.priority,
        enabled: r.enabled,
      }),
    ),
  );
}

/**
 * The fine-grained enforcement seam. Built on `orgProcedure` (which guarantees an
 * authenticated member of the active org), it builds the PARC request, evaluates
 * the org's policies, and throws `FORBIDDEN` with `swarmyCode: 'POLICY_DENIED'`
 * (and the deciding policy id in `cause`) on deny. Every deny and every permit is
 * audited. On permit, ctx is augmented with `{ authz }` for downstream use.
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
    const [principal, engine] = await Promise.all([buildPrincipal(ctx), loadEngine(ctx)]);
    const resource = resolveResource ? await resolveResource(ctx, opts.input) : null;

    const result = engine.evaluate({
      principal,
      action,
      resource,
      context: { now: new Date(), ip: null, userAgent: ctx.reqHeaders.get('user-agent') },
    });

    if (result.decision === 'deny') {
      await writeAudit(ctx, {
        action: `authz.deny:${action}`,
        targetType: resource?.type,
        targetId: resource?.id,
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
      targetType: resource?.type,
      targetId: resource?.id,
      metadata: { policyId: result.policyId },
    });

    return opts.next({
      ctx: { authz: { action, decision: result.decision, policyId: result.policyId } },
    });
  });
}
