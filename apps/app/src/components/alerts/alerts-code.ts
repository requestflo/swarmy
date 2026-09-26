import type { AlertQuietHoursView, AlertRuleView, NotificationChannelView } from '@swarmy/core';
import type { CodeTab } from '@/components/calm';
import { ruleJson } from './rule-facts';

/**
 * Code depth: the selected rule (with its target and mute), every rule, the
 * channels and the quiet hours as read-only JSON, exactly as the dashboard
 * holds them. Alerts have no public REST route yet (plan §7), so no path or
 * CLI command is shown — it is a dashboard setting.
 */
export function alertsCode(
  rule: AlertRuleView | null,
  rules: AlertRuleView[],
  channels: NotificationChannelView[],
  quietHours?: AlertQuietHoursView,
): CodeTab[] {
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
  if (quietHours) {
    const { enabled, start, end, timeZone, criticalPages } = quietHours;
    tabs.push({ label: 'quiet-hours.json', code: JSON.stringify({ enabled, start, end, timeZone, criticalPages }, null, 2) });
  }
  return tabs;
}
