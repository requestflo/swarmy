import { TRPCError } from '@trpc/server';
import { createEngine } from '@swarmy/abac';
import type { OrgContext } from '../context';
import type { SwarmyCode } from '../errors';
import { principalFromMember } from '../abac';
import { effectivePolicyInputs } from './policy-effective';
import { policyRepo, type PolicyRecord, type PolicyWrite } from './policy-repo';

/**
 * Owners can never be locked out of the rules (security review M5). An admin
 * could otherwise forbid `policy.write` for owners, or switch "Owners can do
 * anything" off, and no owner could undo it. Every rule change is evaluated
 * first: when no owner of the org could still change rules afterwards
 * (`policy.write`, the action `policies.set`/`delete` are gated on), it is
 * refused and nothing is written.
 */

export type PolicyChange = { kind: 'upsert'; write: PolicyWrite } | { kind: 'delete'; id: string };

/** Pure: the org's rows after `change` (an update keeps what the write leaves out). */
export function applyPolicyChange(rows: readonly PolicyRecord[], change: PolicyChange): PolicyRecord[] {
  if (change.kind === 'delete') return rows.filter((r) => r.id !== change.id);
  const w = change.write;
  const existing = w.id ? rows.find((r) => r.id === w.id) : undefined;
  const next: PolicyRecord = {
    id: w.id ?? '(new rule)',
    name: w.name,
    description: w.description ?? null,
    effect: w.effect,
    source: w.source,
    priority: w.priority ?? existing?.priority ?? 0,
    enabled: w.enabled ?? existing?.enabled ?? true,
    isDefault: existing?.isDefault ?? false,
    updatedAt: new Date(),
  };
  return existing ? rows.map((r) => (r === existing ? next : r)) : [...rows, next];
}

/** Would any of these owners be permitted `policy.write` under `rows`? */
export async function ownersCanManagePolicies(
  orgId: string,
  owners: Array<{ id: string; userId: string; role: string; attributes: unknown }>,
  rows: readonly PolicyRecord[],
): Promise<boolean> {
  const engine = await createEngine(effectivePolicyInputs(rows));
  const context = { now: new Date(), ip: null, userAgent: null };
  return owners.some(
    (m) =>
      engine.evaluate({ principal: principalFromMember(orgId, m), action: 'policy.write', resource: null, context })
        .decision === 'permit',
  );
}

/** Refuse `change` when it would leave no owner able to change rules. */
export async function assertNoOwnerLockout(ctx: OrgContext, change: PolicyChange): Promise<void> {
  const orgId = ctx.activeOrgId;
  const [rows, owners] = await Promise.all([
    policyRepo(ctx.db).list(orgId),
    ctx.db.member.findMany({
      where: { organizationId: orgId, role: 'owner' },
      select: { id: true, userId: true, role: true, attributes: true },
    }),
  ]);
  if (owners.length === 0) return; // no owner to lock out
  if (await ownersCanManagePolicies(orgId, owners, applyPolicyChange(rows, change))) return;
  throw new TRPCError({
    code: 'BAD_REQUEST',
    message:
      'This change would leave no owner able to change rules. Keep "Owners can do anything" on, or narrow the rule so it spares owners.',
    cause: { swarmyCode: 'POLICY_LOCKOUT' satisfies SwarmyCode },
  });
}
