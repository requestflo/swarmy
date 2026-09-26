import type { AlertRuleView, NotificationChannelView } from '@swarmy/core';
import { formatDuration, formatValue, phraseFor } from './signal-phrases';

export interface RuleShape {
  signal: string;
  threshold: number | null;
  forSeconds: number;
  channelIds: string[];
}

/** "Slack #ops" · "every channel" · "nowhere yet". */
export function routeWords(channelIds: string[], channels: NotificationChannelView[]): string {
  if (channelIds.length === 0) return channels.length ? 'every channel' : 'nowhere yet';
  const names = channels.filter((c) => channelIds.includes(c.id)).map((c) => c.name);
  if (names.length === 0) return 'a removed channel';
  return names.length <= 2 ? names.join(' + ') : `${names[0]} + ${names.length - 1} more`;
}

/**
 * The rule said plainly: "When error rate of any app is above 5% for 5 min →
 * #ops Slack". Event signals: "When a build fails → On-call email".
 */
export function ruleSentence(rule: RuleShape, channels: NotificationChannelView[]): string {
  const p = phraseFor(rule.signal);
  const to = routeWords(rule.channelIds, channels);
  const held = p.held && rule.forSeconds > 0 ? ` for ${formatDuration(rule.forSeconds)}` : '';
  if (p.op === null) return `When ${p.metric}${held} → ${to}`;
  return `When ${p.metric} ${p.scope} is ${p.op} ${formatValue(rule.signal, rule.threshold)}${held} → ${to}`;
}

/**
 * Which rule the controller actually uses for a signal: the oldest custom rule,
 * else the built-in one (alerts-fire `matchRule` + evaluator `ruleSettings`).
 */
export function governingRule(rules: AlertRuleView[], signal: string): AlertRuleView | undefined {
  return rules
    .filter((r) => r.signal === signal)
    .sort((a, b) => Number(a.isDefault) - Number(b.isDefault) || Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
}

/** What saving a new rule for `signal` does to the rules already watching it. */
export function newRuleEffect(rules: AlertRuleView[], signal: string): { kind: 'fresh' | 'replaces' | 'shadowed'; rule?: AlertRuleView } {
  const current = governingRule(rules, signal);
  if (!current) return { kind: 'fresh' };
  return current.isDefault ? { kind: 'replaces', rule: current } : { kind: 'shadowed', rule: current };
}

/** "service:checkout" → "checkout"; "node:wkr-2" → "wkr-2". */
export function resourceName(resource: string): string {
  const i = resource.indexOf(':');
  return i >= 0 ? resource.slice(i + 1) : resource;
}
