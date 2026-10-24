import { TRPCError } from '@trpc/server';
import type { OrgContext } from '../context';
import { evaluateAccess, resolveStackByName } from '../abac';
import { writeAudit } from './audit.service';

/**
 * The `data.read` gate for "Try it" (search hits are the app's documents),
 * the way the database studio gates a read: the stack is the resource (so
 * production is read off its live labels), a deny is audited and refused, and
 * a permit is recorded ONCE — on the caller's own `search.query` row, which
 * carries the deciding policy this returns.
 */
export async function readGate(ctx: OrgContext, stack: string): Promise<string | null> {
  const resource = await resolveStackByName(ctx, { stack });
  const res = await evaluateAccess(ctx, 'data.read', resource);
  if (res.decision === 'deny') {
    await writeAudit(ctx, {
      action: 'authz.deny:data.read',
      targetType: res.resource?.type ?? 'stack',
      targetId: res.resource?.id ?? stack,
      metadata: { policyId: res.policyId, reasons: res.reasons, via: 'search.query' },
    });
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'not permitted: data.read',
      cause: { swarmyCode: 'POLICY_DENIED', policyId: res.policyId },
    });
  }
  return res.policyId ?? null;
}
