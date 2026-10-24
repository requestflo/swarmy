import type { GuardrailRuleId } from './views';

/**
 * Admission receipts: what one deploy's admission run decided, per rule or
 * check, as it lands in the audit log (the controller's admission gate writes
 * it through `writeAudit`). Pure and browser-safe, so the controller builds the
 * rows and the dashboard (and the demo) count them back with `tallyAdmission`.
 *
 * One row per admission run that has something to say:
 *   blocked    refused: a `block` violation and no permitted override
 *   warned     only warnings: held for a confirmation, or passed by automation
 *   overridden went past a violation by an explicit override (the override actions)
 *   allowed    passed clean, but a Warn or Off guardrail would have refused it at Block
 *
 * A clean pass with nothing in `wouldBlock` writes no row: the deploy's own
 * `stack.deploy` / `service.deploy` row already says it shipped, and a row per
 * passing rule would bury the decisions that matter.
 */
export const ADMISSION_ACTIONS = {
  blocked: 'guardrails.deploy.blocked',
  warned: 'guardrails.deploy.warned',
  allowed: 'guardrails.deploy.allowed',
  stackOverride: 'stack.deploy.override',
  serviceOverride: 'service.deploy.override',
} as const;

/** Every audit action an admission run can write (the receipts query reads these). */
export const ADMISSION_ACTION_LIST: readonly string[] = Object.values(ADMISSION_ACTIONS);

export type AdmissionOutcome = 'allowed' | 'warned' | 'blocked' | 'overridden';
export type AdmissionCheckOutcome = Exclude<AdmissionOutcome, 'allowed'>;
/** `automation` = nobody can confirm: warns pass, any `block` refuses. */
export type AdmissionMode = 'interactive' | 'automation';

/** The slice of an admission violation the receipts need. */
export interface AdmissionViolationLike {
  rule: string;
  severity: 'block' | 'warn';
  message: string;
  resource?: string;
}

/** One rule's or check's outcome in one admission run (passes are not listed). */
export interface AdmissionCheck {
  rule: string;
  outcome: AdmissionCheckOutcome;
  resources: string[];
}

/** A Warn or Off guardrail that, set to Block, would have refused this run. */
export interface WouldBlockHit {
  rule: string;
  level: 'warn' | 'off';
  resources: string[];
}

/** The audit row's metadata for one admission run. */
export interface AdmissionRecordMeta {
  kind: string;
  stackName: string | null;
  mode: AdmissionMode;
  outcome: AdmissionOutcome;
  /** The deploy went on to the swarm. */
  admitted: boolean;
  violations: AdmissionViolationLike[];
  checks: AdmissionCheck[];
  wouldBlock: WouldBlockHit[];
  reason?: string;
}

/** `noLatestTagInProd` → `guardrails/no-latest-tag-in-prod`, the key its violations carry. */
export function guardrailRuleKey(id: GuardrailRuleId): string {
  return `guardrails/${id.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/** The run's outcome: a `block` decides it; warnings alone are `warned`; nothing is `allowed`. */
export function admissionOutcome(violations: readonly AdmissionViolationLike[], admitted: boolean): AdmissionOutcome {
  if (violations.length === 0) return 'allowed';
  if (violations.some((v) => v.severity === 'block')) return admitted ? 'overridden' : 'blocked';
  return 'warned';
}

/** One entry per rule or check that fired, with the services or clusters it named. */
export function admissionChecks(violations: readonly AdmissionViolationLike[], admitted: boolean): AdmissionCheck[] {
  const byRule = new Map<string, { block: boolean; resources: Set<string> }>();
  for (const v of violations) {
    const entry = byRule.get(v.rule) ?? { block: false, resources: new Set<string>() };
    if (v.severity === 'block') entry.block = true;
    if (v.resource) entry.resources.add(v.resource);
    byRule.set(v.rule, entry);
  }
  return [...byRule].map(([rule, e]) => ({
    rule,
    outcome: !e.block ? 'warned' : admitted ? 'overridden' : 'blocked',
    resources: [...e.resources],
  }));
}

export interface AdmissionRecordInput {
  kind: string;
  stackName?: string;
  mode: AdmissionMode;
  violations: readonly AdmissionViolationLike[];
  wouldBlock: readonly WouldBlockHit[];
  admitted: boolean;
  reason?: string;
}

/** The audit row for one admission run, or null when a clean pass has nothing to say. */
export function admissionRecord(input: AdmissionRecordInput): { action: string; metadata: AdmissionRecordMeta } | null {
  const outcome = admissionOutcome(input.violations, input.admitted);
  // An interactive run only goes past a violation by an explicit override.
  const overridden = input.mode === 'interactive' && input.admitted && input.violations.length > 0;
  const action = overridden
    ? input.kind === 'stack.deploy'
      ? ADMISSION_ACTIONS.stackOverride
      : ADMISSION_ACTIONS.serviceOverride
    : outcome === 'allowed'
      ? input.wouldBlock.length > 0
        ? ADMISSION_ACTIONS.allowed
        : null
      : outcome === 'warned'
        ? ADMISSION_ACTIONS.warned
        : ADMISSION_ACTIONS.blocked;
  if (!action) return null;
  return {
    action,
    metadata: {
      kind: input.kind,
      stackName: input.stackName ?? null,
      mode: input.mode,
      outcome,
      admitted: input.admitted,
      violations: input.violations.map((v) => ({ ...v })),
      checks: admissionChecks(input.violations, input.admitted),
      wouldBlock: input.wouldBlock.map((h) => ({ ...h, resources: [...h.resources] })),
      ...(input.reason ? { reason: input.reason } : {}),
    },
  };
}
