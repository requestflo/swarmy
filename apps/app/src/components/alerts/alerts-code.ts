import type { AlertQuietHoursView, AlertRuleView, NotificationChannelKindView, NotificationChannelView } from '@swarmy/core';
import { curl, restExchange, tfNames, tfRef, tfResource, tfVariable, withHeader, type CodeTab, type Hcl } from '@/components/calm';

/**
 * Code depth for Alerts: the rule in the editor over REST (`/alert-rules`,
 * `/notification-channels` in packages/api-rest/openapi.json) and as
 * Terraform (`swarmy_alert_rule`, `swarmy_notification_channel`). The DTOs
 * are the REST mappers' (mappers-alerts.ts), snake_case. Quiet hours and
 * mutes are dashboard-only, so they stay read-only JSON.
 */

/** The rule as REST returns it (`alertRuleToDto`). */
function ruleDto(r: AlertRuleView) {
  return {
    id: r.id,
    name: r.name,
    signal: r.signal,
    selector: { ...r.selector },
    threshold: r.threshold,
    for_seconds: r.forSeconds,
    channel_ids: r.channelIds,
    enabled: r.enabled,
    is_default: r.isDefault,
    muted_until: r.mutedUntil,
    created_at: r.createdAt,
  };
}

/** The channel as REST returns it (`notificationChannelToDto`): the destination redacted. */
function channelDto(c: NotificationChannelView) {
  return { id: c.id, name: c.name, kind: c.kind, enabled: c.enabled, target: c.target, has_secret: c.hasSecret, created_at: c.createdAt };
}

/** The write-only destination attributes each kind takes (resource_notification_channel.go). */
const DESTINATION: Record<NotificationChannelKindView, string[]> = {
  email: ['to'],
  slack: ['url'],
  teams: ['url'],
  discord: ['url'],
  webhook: ['url'],
  telegram: ['bot_token', 'chat_id'],
  ntfy: ['server', 'topic'],
  gotify: ['server', 'token'],
};

function restCalls(rule: AlertRuleView | null): string {
  const lines: string[] = [];
  if (rule) {
    const { name, selector, threshold, for_seconds, channel_ids, enabled } = ruleDto(rule);
    lines.push('# Change this rule (fields left out keep their value):', curl('PATCH', `/alert-rules/${rule.id}`, { name, selector, threshold, for_seconds, channel_ids, enabled }), '');
  }
  lines.push('# Every rule, and every channel (destinations redacted):', curl('GET', '/alert-rules'), curl('GET', '/notification-channels'));
  return lines.join('\n');
}

/** The rule and the channels it sends to; destinations come from variables (write-only). */
function terraform(rule: AlertRuleView, channels: NotificationChannelView[]): string {
  const used = channels.filter((c) => rule.channelIds.includes(c.id));
  const names = tfNames(used.map((c) => c.name), 'channel');
  const [ruleName] = tfNames([rule.name], 'rule');
  const blocks: string[] = [];
  used.forEach((c, i) => {
    const n = names[i] ?? 'channel';
    const dest = DESTINATION[c.kind] ?? [];
    blocks.push(...dest.map((a) => tfVariable(`${n}_${a}`)));
    const attrs: Record<string, Hcl | undefined> = { name: c.name, kind: c.kind };
    for (const a of dest) attrs[a] = tfRef(`var.${n}_${a}`);
    if (!c.enabled) attrs.enabled = false;
    blocks.push(tfResource('swarmy_notification_channel', n, attrs));
  });
  blocks.push(
    tfResource('swarmy_alert_rule', ruleName ?? 'rule', {
      name: rule.name,
      signal: rule.signal,
      app: rule.selector.app,
      server: rule.selector.server,
      service: rule.selector.service,
      threshold: rule.threshold ?? undefined,
      for_seconds: rule.forSeconds > 0 ? rule.forSeconds : undefined,
      channel_ids: used.length > 0 ? names.map((n) => tfRef(`swarmy_notification_channel.${n}.id`)) : undefined,
      enabled: rule.enabled ? undefined : false,
    }),
  );
  const imports = [
    ...used.map((c, i) => `#   terraform import swarmy_notification_channel.${names[i] ?? 'channel'} ${c.id}`),
    `#   terraform import swarmy_alert_rule.${ruleName ?? 'rule'} ${rule.id}`,
  ];
  const head = rule.isDefault
    ? '# A seeded default: import it rather than creating a second rule. Destroying\n# an imported default opts the workspace out of it.'
    : '# Already in the dashboard? Import it rather than creating it twice:';
  return `${blocks.join('\n\n')}\n\n${head}\n${imports.join('\n')}`;
}

export function alertsCode(
  rule: AlertRuleView | null,
  rules: AlertRuleView[],
  channels: NotificationChannelView[],
  quietHours?: AlertQuietHoursView,
): CodeTab[] {
  const tabs: CodeTab[] = [{ label: 'curl', code: restCalls(rule) }];
  if (rule) {
    tabs.push({ label: 'Terraform', code: terraform(rule, channels) });
    tabs.push({ label: 'rule', code: restExchange('GET', `/alert-rules/${rule.id}`, ruleDto(rule)) });
  } else {
    tabs.push({ label: 'rules', code: restExchange('GET', '/alert-rules', { data: rules.map(ruleDto), next_cursor: null }) });
  }
  tabs.push({ label: 'channels', code: restExchange('GET', '/notification-channels', { data: channels.map(channelDto), next_cursor: null }) });
  if (quietHours) {
    const { enabled, start, end, timeZone, criticalPages } = quietHours;
    tabs.push({ label: 'quiet hours', code: withHeader('Dashboard setting: quiet hours have no REST route.', JSON.stringify({ enabled, start, end, timeZone, criticalPages }, null, 2)) });
  }
  return tabs;
}
