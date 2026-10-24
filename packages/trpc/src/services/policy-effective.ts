import { defaultPolicyInputs, type PolicyInput } from '@swarmy/abac';
import type { PolicyRecord } from './policy-repo';

/**
 * Pure: the policy set the engine runs for an org's stored rows. Always the
 * SHIPPED default rules (a stored default row only carries the admin's
 * enable/disable and a real id for the audit trail), plus the enabled custom
 * rules. No rows at all means every shipped default, enabled.
 *
 * `loadPolicyInputs` (abac.ts) evaluates the stored rows through this, and
 * the owner-lockout guard evaluates a proposed change through it, so both
 * judge the same set.
 */
export function effectivePolicyInputs(rows: readonly PolicyRecord[]): PolicyInput[] {
  const defaults: PolicyInput[] = defaultPolicyInputs().map((p) => {
    const stored = storedDefaultFor(rows, p);
    return {
      id: stored?.id ?? `default:${p.key}`,
      name: p.name,
      effect: p.effect,
      source: p.source,
      priority: p.priority,
      enabled: stored ? stored.enabled : true,
    };
  });
  const custom: PolicyInput[] = rows
    .filter((r) => !r.isDefault && r.enabled)
    .map((r) => ({ id: r.id, name: r.name, effect: r.effect, source: r.source, priority: r.priority, enabled: true }));
  return [...defaults.filter((d) => d.enabled), ...custom];
}

/**
 * The stored row that carries a shipped default's enable/disable: by name,
 * else by source, for a row renamed before renames were refused. Matching on
 * the source keeps an admin's "off" through the rewrite that follows a rename
 * (`ensureDefaults`); matching on the name alone switched the rule back on.
 */
export function storedDefaultFor<R extends Pick<PolicyRecord, 'name' | 'source' | 'isDefault'>>(
  rows: readonly R[],
  shipped: { name: string; source: string },
): R | undefined {
  const stored = rows.filter((r) => r.isDefault);
  return stored.find((r) => r.name === shipped.name) ?? stored.find((r) => r.source === shipped.source);
}
