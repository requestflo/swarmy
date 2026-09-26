import type { AlertRuleView, NotificationChannelView } from '@swarmy/core';
import type { CodeTab } from '@/components/calm';
import { ruleJson } from './rule-facts';

/**
 * Code depth: the selected rule and the channels as read-only JSON, exactly as
 * the dashboard holds them. Alerts have no public REST route yet (plan §7),
 * so no path or CLI command is shown.
 */
export function alertsCode(rule: AlertRuleView | null, rules: AlertRuleView[], channels: NotificationChannelView[]): CodeTab[] {
  const tabs: CodeTab[] = [];
  if (rule) tabs.push({ label: 'rule.json', code: ruleJson(rule, rule.id) });
  tabs.push({ label: 'rules.json', code: JSON.stringify(rules.map((r) => JSON.parse(ruleJson(r, r.id)) as unknown), null, 2) });
  tabs.push({
    label: 'channels.json',
    code: JSON.stringify(
      channels.map((c) => ({ id: c.id, name: c.name, kind: c.kind, target: c.target, signed: c.hasSecret, enabled: c.enabled })),
      null,
      2,
    ),
  });
  return tabs;
}
