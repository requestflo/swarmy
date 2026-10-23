/** One guardrail / exposure / image-policy finding that stopped a deploy. */
export interface RefusedViolation {
  rule: string;
  severity: 'block' | 'warn';
  message: string;
  resource?: string;
}

/** A deploy the admission gate refused, as the override panel needs it. */
export interface PolicyRefusal {
  violations: RefusedViolation[];
  /** Any `block` finding: only an admin or owner may deploy past it, with a reason. */
  blocking: boolean;
}

/** The swarmyCodes an admission refusal comes back with (see trpc admission-gate). */
const REFUSAL_CODES = new Set(['POLICY_DENIED', 'OVERRIDE_REASON_REQUIRED']);

interface ErrorLike {
  data?: { swarmyCode?: string | null; violations?: unknown } | null;
}

/**
 * Read an admission refusal out of a tRPC error, or null when the error is
 * anything else (including a plain policy deny, which carries no violations).
 */
export function policyRefusal(err: ErrorLike | null | undefined): PolicyRefusal | null {
  const data = err?.data;
  if (!data?.swarmyCode || !REFUSAL_CODES.has(data.swarmyCode)) return null;
  if (!Array.isArray(data.violations)) return null;
  const violations: RefusedViolation[] = [];
  for (const raw of data.violations) {
    if (typeof raw !== 'object' || raw === null) continue;
    const v = raw as Record<string, unknown>;
    if (typeof v.rule !== 'string' || typeof v.message !== 'string') continue;
    violations.push({
      rule: v.rule,
      severity: v.severity === 'warn' ? 'warn' : 'block',
      message: v.message,
      ...(typeof v.resource === 'string' ? { resource: v.resource } : {}),
    });
  }
  if (violations.length === 0) return null;
  return { violations, blocking: violations.some((v) => v.severity === 'block') };
}
