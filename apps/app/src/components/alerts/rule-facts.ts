import type { AlertRuleView } from '@swarmy/core';
import { phraseFor } from './signal-phrases';
import type { RuleShape } from './rule-sentence';

/** apps/api/src/workers/alert-evaluator.ts `TICK_MS` (30 000): rules are re-read every tick. */
export const EVALUATOR_TICK_SECONDS = 30;

/** Controls-depth tech line: the raw comparison the evaluator runs. */
export function rawExpression(rule: RuleShape): string {
  const p = phraseFor(rule.signal);
  const cmp = p.op === 'above' ? '>' : '≥';
  const value = p.op === null ? 'event' : `${cmp} ${rule.threshold ?? 'default'}${p.unit === '%' ? '%' : p.unit}`;
  const held = p.held ? ` · held ${rule.forSeconds}s` : '';
  return `${rule.signal} ${value}${held}`;
}

/** The evaluator's dedupe key shape (`conditionKey`): one open event per signal + resource. */
export function evaluatorKey(signal: string): string {
  return `${signal}|<resource>`;
}

/** Code depth: the rule exactly as the dashboard holds it (no REST route yet). */
export function ruleJson(rule: (RuleShape & { name: string; enabled: boolean }) | AlertRuleView, id?: string): string {
  const { name, signal, threshold, forSeconds, channelIds, enabled } = rule;
  return JSON.stringify({ ...(id ? { id } : {}), name, signal, threshold, forSeconds, channelIds, enabled }, null, 2);
}
