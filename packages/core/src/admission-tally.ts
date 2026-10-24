import {
  ADMISSION_ACTION_LIST,
  ADMISSION_ACTIONS,
  admissionChecks,
  admissionOutcome,
  type AdmissionCheck,
  type AdmissionOutcome,
  type AdmissionViolationLike,
  type WouldBlockHit,
} from './admission-record';
import type { AdmissionRuleTally, AdmissionTallyView } from './views';

/**
 * Count admission receipts per rule or check: what each one blocked, warned
 * on, saw overridden, and (for Warn and Off guardrails) would have blocked.
 * Rows written before receipts carried `checks` (blocked and override rows
 * only) are read from their violations, so older history still counts.
 */

/** The slice of an audit row the tally reads. */
export interface AdmissionRowLike {
  action: string;
  targetId?: string | null;
  metadata: unknown;
}

/** One audit row read back as a decision. */
export interface AdmissionRowRead {
  outcome: AdmissionOutcome;
  admitted: boolean;
  stack: string | null;
  checks: AdmissionCheck[];
  wouldBlock: WouldBlockHit[];
}

const OUTCOMES = new Set<AdmissionOutcome>(['allowed', 'warned', 'blocked', 'overridden']);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);

function violationsOf(meta: Record<string, unknown>): AdmissionViolationLike[] {
  if (!Array.isArray(meta.violations)) return [];
  return meta.violations.filter(isObj).flatMap((v) =>
    typeof v.rule === 'string'
      ? [{ rule: v.rule, severity: v.severity === 'warn' ? ('warn' as const) : ('block' as const), message: String(v.message ?? ''), ...(typeof v.resource === 'string' ? { resource: v.resource } : {}) }]
      : [],
  );
}

function checksOf(raw: unknown): AdmissionCheck[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isObj).flatMap((c) =>
    typeof c.rule === 'string' && (c.outcome === 'blocked' || c.outcome === 'warned' || c.outcome === 'overridden')
      ? [{ rule: c.rule, outcome: c.outcome, resources: strings(c.resources) }]
      : [],
  );
}

function wouldBlockOf(raw: unknown): WouldBlockHit[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isObj).flatMap((h) =>
    typeof h.rule === 'string' ? [{ rule: h.rule, level: h.level === 'warn' ? ('warn' as const) : ('off' as const), resources: strings(h.resources) }] : [],
  );
}

/** An older row's outcome: its violations decide, else its action does. */
function legacyOutcome(action: string, derived: AdmissionOutcome): AdmissionOutcome {
  if (derived !== 'allowed') return derived;
  if (action === ADMISSION_ACTIONS.blocked) return 'blocked';
  if (action === ADMISSION_ACTIONS.warned) return 'warned';
  return action === ADMISSION_ACTIONS.allowed ? 'allowed' : 'overridden';
}

/** Read one audit row as an admission decision; null for a row that isn't one. */
export function readAdmissionRow(row: AdmissionRowLike): AdmissionRowRead | null {
  const override = row.action === ADMISSION_ACTIONS.stackOverride || row.action === ADMISSION_ACTIONS.serviceOverride;
  if (!ADMISSION_ACTION_LIST.includes(row.action)) return null;
  const meta = isObj(row.metadata) ? row.metadata : {};
  const admitted =
    typeof meta.admitted === 'boolean' ? meta.admitted : override || row.action === ADMISSION_ACTIONS.allowed;
  const violations = violationsOf(meta);
  const outcome = OUTCOMES.has(meta.outcome as AdmissionOutcome)
    ? (meta.outcome as AdmissionOutcome)
    : legacyOutcome(row.action, admissionOutcome(violations, admitted));
  return {
    outcome,
    admitted,
    stack: typeof meta.stackName === 'string' ? meta.stackName : (row.targetId ?? null),
    checks: Array.isArray(meta.checks) ? checksOf(meta.checks) : admissionChecks(violations, admitted),
    wouldBlock: wouldBlockOf(meta.wouldBlock),
  };
}

/**
 * Tally rows (newest first) per rule. `wouldBlock` counts only runs that went
 * ahead: "on Block it would have stopped N" means N deploys shipped past it.
 */
export function tallyAdmission(rows: readonly AdmissionRowLike[]): Pick<AdmissionTallyView, 'totals' | 'blockedBy' | 'rules'> {
  const totals = { blocked: 0, warned: 0, overridden: 0, allowed: 0 };
  const blockedBy: Record<string, number> = {};
  const byRule = new Map<string, AdmissionRuleTally>();
  const entry = (rule: string): AdmissionRuleTally => {
    let t = byRule.get(rule);
    if (!t) byRule.set(rule, (t = { rule, blocked: 0, warned: 0, overridden: 0, wouldBlock: 0, stacks: [] }));
    return t;
  };
  const touch = (t: AdmissionRuleTally, stack: string | null): void => {
    if (stack && t.stacks.length < 3 && !t.stacks.includes(stack)) t.stacks.push(stack);
  };
  for (const row of rows) {
    const r = readAdmissionRow(row);
    if (!r) continue;
    totals[r.outcome] += 1;
    for (const family of new Set(r.checks.filter((c) => c.outcome === 'blocked').map((c) => c.rule.split('/')[0] ?? c.rule))) {
      blockedBy[family] = (blockedBy[family] ?? 0) + 1;
    }
    for (const c of r.checks) {
      const t = entry(c.rule);
      t[c.outcome] += 1;
      touch(t, r.stack);
    }
    if (!r.admitted) continue;
    for (const rule of new Set(r.wouldBlock.map((h) => h.rule))) {
      const t = entry(rule);
      t.wouldBlock += 1;
      touch(t, r.stack);
    }
  }
  return { totals, blockedBy, rules: [...byRule.values()].sort((a, b) => a.rule.localeCompare(b.rule)) };
}

/** A zeroed tally for a rule with no record in the window. */
export function emptyRuleTally(rule: string): AdmissionRuleTally {
  return { rule, blocked: 0, warned: 0, overridden: 0, wouldBlock: 0, stacks: [] };
}
