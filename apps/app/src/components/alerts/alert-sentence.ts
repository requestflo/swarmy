import type { AlertRuleView, NotificationChannelView } from '@swarmy/core';
import { forDuration, signalInfo } from './alert-tones';

/** "above 85% for 15m → On-call email" — a rule said plainly. */
export function ruleSentence(rule: AlertRuleView, channels: NotificationChannelView[]): string {
  const { unit } = signalInfo(rule.signal);
  const when =
    rule.threshold !== null && unit
      ? unit === '%' ? `Above ${rule.threshold}%` : `At ${rule.threshold} ${unit}`
      : 'Whenever it happens';
  const dur = rule.forSeconds > 0 ? ` for ${forDuration(rule.forSeconds)}` : '';
  const names = channels.filter((c) => rule.channelIds.includes(c.id)).map((c) => c.name);
  const to = rule.channelIds.length === 0 ? (channels.length ? 'every channel' : 'nowhere yet') : names.join(', ') || 'a removed channel';
  return `${when}${dur} → ${to}`;
}
