import type { AlertRuleView } from '@swarmy/core';

/**
 * A rule's route on the "Events I care about" table. `[]` is All: every
 * enabled channel, today's and tomorrow's. Picking or unpicking one channel
 * starts from what the rule really reaches; a list that ends up naming every
 * enabled channel — or none, since a rule always goes somewhere (off is the
 * On switch) — is All again.
 */
export function flipRoute(channelIds: string[], live: string[], id: string): string[] {
  const base = channelIds.length ? channelIds : live;
  const list = base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
  const everyLive = list.length === 0 || (list.length === live.length && live.every((x) => list.includes(x)));
  return everyLive ? [] : list;
}

/** How many (rule, enabled channel) deliveries the enabled rules make. */
export function deliveries(rules: Pick<AlertRuleView, 'enabled' | 'channelIds'>[], live: string[]): number {
  return rules
    .filter((r) => r.enabled)
    .reduce((n, r) => n + (r.channelIds.length ? r.channelIds.filter((id) => live.includes(id)).length : live.length), 0);
}
