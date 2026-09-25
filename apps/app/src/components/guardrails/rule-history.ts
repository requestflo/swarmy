import type { GuardrailDecisionView } from '@swarmy/core';

/** "Last 30 days it stopped 2 deploys: blog, storefront." — one rule's record, from the decisions feed. */
export function ruleHistory(ruleId: string, decisions: GuardrailDecisionView[]): { line: string; hits: number; stopped: number } {
  const since = Date.now() - 30 * 86_400_000;
  const kebab = `guardrails/${ruleId.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
  const hits = decisions.filter((d) => new Date(d.at).getTime() >= since && d.violations.some((v) => v.rule === ruleId || v.rule === kebab));
  if (hits.length === 0) return { line: 'Last 30 days: nothing hit this rule.', hits: 0, stopped: 0 };
  const blocked = hits.filter((d) => d.kind === 'blocked');
  const over = hits.length - blocked.length;
  const apps = [...new Set(hits.map((d) => d.stack).filter(Boolean))].slice(0, 3).join(', ');
  const parts = [
    blocked.length ? `stopped ${blocked.length} deploy${blocked.length === 1 ? '' : 's'}` : null,
    over ? `was overridden ${over} time${over === 1 ? '' : 's'}` : null,
  ].filter(Boolean);
  return { line: `Last 30 days it ${parts.join(' and ')}${apps ? `: ${apps}` : ''}.`, hits: hits.length, stopped: blocked.length };
}
