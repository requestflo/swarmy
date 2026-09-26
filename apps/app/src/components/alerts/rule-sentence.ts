import {
  describeAlertTarget,
  selectorMatches,
  subjectFromResource,
  type AlertSelector,
  type AlertRuleView,
  type NotificationChannelView,
} from '@swarmy/core';
import { formatDuration, formatValue, phraseFor } from './signal-phrases';

export interface RuleShape {
  signal: string;
  /** The rule's target (`{}` = any). */
  selector: AlertSelector;
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

/** "any app" · "storefront" · "storefront / checkout" · "london-2"; null when the signal has no target. */
export function targetWords(signal: string, selector: AlertSelector): string | null {
  return describeAlertTarget(signal, selector);
}

/**
 * The rule said plainly: "When error rate of storefront / checkout is above
 * 5% for 5 min → #ops Slack". Event signals: "When a build fails → On-call
 * email"; "When checking in stops on london-2 for 5 min → phones".
 */
export function ruleSentence(rule: RuleShape, channels: NotificationChannelView[]): string {
  const p = phraseFor(rule.signal);
  const to = routeWords(rule.channelIds, channels);
  const held = p.held && rule.forSeconds > 0 ? ` for ${formatDuration(rule.forSeconds)}` : '';
  const target = p.prep ? targetWords(rule.signal, rule.selector) : null;
  const scope = target ? ` ${p.prep} ${target}` : '';
  if (p.op === null) return `When ${p.metric}${scope}${held} → ${to}`;
  return `When ${p.metric}${scope} is ${p.op} ${formatValue(rule.signal, rule.threshold)}${held} → ${to}`;
}

/**
 * The rule an unattributed (ruleless) event belongs to on screen: the first
 * enabled rule for its signal whose target covers it. Every rule owns its own
 * events server-side (Q10), so this only matters for pre-Q10 rows.
 */
export function ruleForEvent(rules: AlertRuleView[], signal: string, resource: string): AlertRuleView | undefined {
  const subject = subjectFromResource(resource);
  return rules.find((r) => r.signal === signal && r.enabled && selectorMatches(r.selector, subject));
}

/** "service:storefront_checkout" → "storefront / checkout"; "node:wkr-2" → "wkr-2". */
export function resourceName(resource: string): string {
  const s = subjectFromResource(resource);
  if (s.server) return s.server;
  if (s.app && s.service) return `${s.app} / ${s.service}`;
  if (s.app) return s.app;
  if (s.service) return s.service;
  const i = resource.indexOf(':');
  return i >= 0 ? resource.slice(i + 1) : resource;
}

/** Is this rule muted right now? */
export function isMuted(rule: Pick<AlertRuleView, 'mutedUntil'>, now = Date.now()): boolean {
  return rule.mutedUntil !== null && Date.parse(rule.mutedUntil) > now;
}

/** "11:40" — a wall-clock time in the viewer's zone. */
export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}
