import { emptyRuleTally, guardrailRuleKey, type AdmissionTallyView, type GuardrailRuleView } from '@swarmy/core';

export type RuleRecordTone = 'ok' | 'warn' | 'idle';

const deploys = (n: number, floor: string): string => (n === 0 ? 'nothing' : `${floor}${n} deploy${n === 1 ? '' : 's'}`);
const times = (n: number, floor: string): string => `${floor}${n} time${n === 1 ? '' : 's'}`;

/**
 * One guardrail's record from the admission receipts (`guardrails.tally`).
 * A rule that blocks says what it stopped and what went past it by override.
 * A Warn or Off rule says what Block would have stopped: deploys that shipped
 * past it in the window. Under safety mode a prod-only rule blocks wherever
 * it applies, so it reads as a blocking rule.
 */
export function ruleRecord(rule: GuardrailRuleView, safetyMode: boolean, tally: AdmissionTallyView): { line: string; tone: RuleRecordTone } {
  const t = tally.rules.find((r) => r.rule === guardrailRuleKey(rule.id)) ?? emptyRuleTally(guardrailRuleKey(rule.id));
  const floor = tally.capped ? 'at least ' : '';
  const span = `${tally.days} days`;
  const apps = t.stacks.length ? `: ${t.stacks.join(', ')}` : '';
  const level = rule.enabled ? rule.severity : 'off';

  if (level === 'block' || (safetyMode && rule.prodOnly)) {
    if (t.blocked + t.overridden === 0) return { line: `Last ${span}: nothing hit this rule.`, tone: 'idle' };
    const parts = [
      t.blocked ? `stopped ${deploys(t.blocked, floor)}` : null,
      t.overridden ? `was overridden ${times(t.overridden, floor)}` : null,
    ].filter(Boolean);
    return { line: `Last ${span} it ${parts.join(' and ')}${apps}.`, tone: t.blocked ? 'ok' : 'warn' };
  }

  const extra = [
    level === 'warn' && t.warned ? `It warned ${times(t.warned, floor)}.` : null,
    safetyMode && t.blocked ? `In production it stopped ${deploys(t.blocked, floor)}.` : null,
  ].filter(Boolean);
  const line = `On Block it would have stopped ${deploys(t.wouldBlock, floor)} in ${span}${t.wouldBlock ? apps : ''}.`;
  return { line: [line, ...extra].join(' '), tone: t.wouldBlock ? 'warn' : 'idle' };
}
