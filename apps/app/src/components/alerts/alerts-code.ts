import type { AlertRuleView, NotificationChannelView } from '@swarmy/core';
import { toYaml, type CodeTab } from '@/components/calm';

/** Code depth: the rules and channels exactly as swarmy holds them (dashboard state, no REST route yet). */
export function alertsCode(rules: AlertRuleView[], channels: NotificationChannelView[]): CodeTab[] {
  const byId = new Map(channels.map((c) => [c.id, c.name]));
  return [
    {
      label: 'rules',
      code: toYaml({
        rules: rules.map((r) => ({
          name: r.name,
          signal: r.signal,
          threshold: r.threshold,
          for_seconds: r.forSeconds,
          channels: r.channelIds.length ? r.channelIds.map((id) => byId.get(id) ?? id) : 'all',
          enabled: r.enabled,
        })),
      }),
    },
    {
      label: 'channels',
      code: toYaml({
        channels: channels.map((c) => ({ name: c.name, kind: c.kind, target: c.target, signed: c.hasSecret, enabled: c.enabled })),
      }),
    },
  ];
}
