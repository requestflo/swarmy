import type { AlertRuleView, NotificationChannelView } from '@swarmy/core';

export interface ChannelReach {
  /** Rules that would notify this channel when they fire. */
  gets: number;
  /** Rules that can notify anyone (enabled ones). */
  of: number;
  /** Of `gets`: rules that name this channel; the rest go to every channel. */
  named: number;
}

/**
 * "Gets 9 of 14 rules" (board 55). A rule with no channels goes to every
 * enabled channel (alerts-fire `ruleChannels`); one naming channels goes to
 * those. A disabled rule sends nothing, and a channel that is off gets nothing.
 */
export function channelReach(channel: Pick<NotificationChannelView, 'id' | 'enabled'>, rules: readonly Pick<AlertRuleView, 'enabled' | 'channelIds'>[]): ChannelReach {
  const live = rules.filter((r) => r.enabled);
  if (!channel.enabled) return { gets: 0, of: live.length, named: 0 };
  const named = live.filter((r) => r.channelIds.includes(channel.id)).length;
  const everyone = live.filter((r) => r.channelIds.length === 0).length;
  return { gets: named + everyone, of: live.length, named };
}

/** "Gets 9 of 14 rules" · "Gets every rule" · "Off: gets no rules". */
export function reachWords(r: ChannelReach, enabled: boolean): string {
  if (!enabled) return 'Off: gets no rules';
  if (r.of === 0) return 'No rules yet';
  if (r.gets === r.of) return r.of === 1 ? 'Gets the one rule' : `Gets all ${r.of} rules`;
  return `Gets ${r.gets} of ${r.of} rules`;
}
