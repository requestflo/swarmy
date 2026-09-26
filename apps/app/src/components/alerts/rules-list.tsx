import * as React from 'react';
import type { AlertEventView, AlertRuleView, NotificationChannelView } from '@swarmy/core';
import { EVALUATOR_TICK_SECONDS } from './rule-facts';
import { RuleCard } from './rule-card';
import { ruleForEvent } from './rule-sentence';

/** The board's list length: firing rules and the one being edited always show too. */
const SHOWN = 6;

interface RulesListProps {
  rules: AlertRuleView[];
  channels: NotificationChannelView[];
  events: AlertEventView[];
  firingByRule: Map<string, AlertEventView[]>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/**
 * Firing rules first, then custom rules, then the built-in ones; rules that
 * share a signal sit together (a signal can have several, one per target).
 */
export function orderRules(rules: AlertRuleView[], firingByRule: Map<string, unknown>): AlertRuleView[] {
  const firstIndex = new Map<string, number>();
  const base = [...rules].sort(
    (a, b) => Number(firingByRule.has(b.id)) - Number(firingByRule.has(a.id)) || Number(a.isDefault) - Number(b.isDefault),
  );
  base.forEach((r, i) => {
    if (!firstIndex.has(r.signal)) firstIndex.set(r.signal, i);
  });
  return base
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (firstIndex.get(a.r.signal) ?? 0) - (firstIndex.get(b.r.signal) ?? 0) || a.i - b.i)
    .map(({ r }) => r);
}

/** "17 RULES · 2 FIRING · evaluated every 30 s", then one quiet card per rule. */
export function RulesList({ rules, channels, events, firingByRule, selectedId, onSelect }: RulesListProps): React.JSX.Element {
  const [all, setAll] = React.useState(false);
  const firingCount = rules.filter((r) => firingByRule.has(r.id)).length;
  const ordered = orderRules(rules, firingByRule);
  const shown = all ? ordered : ordered.filter((r, i) => i < SHOWN || r.id === selectedId || firingByRule.has(r.id));
  return (
    <section aria-label="Alert rules" className="flex min-w-0 flex-col gap-3">
      <p className="text-muted-foreground flex flex-wrap justify-between gap-x-3 font-mono text-[11px] tracking-[0.08em] uppercase">
        <span>
          {rules.length} rules · {firingCount} firing
        </span>
        <span className="normal-case tracking-normal">evaluated every {EVALUATOR_TICK_SECONDS} s</span>
      </p>
      {rules.length === 0 ? (
        <p className="calm-card text-muted-foreground px-4 py-4 text-sm">
          No rules yet. Add one and swarmy starts watching on its next check.
        </p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {shown.map((r) => (
            <li key={r.id}>
              <RuleCard
                rule={r}
                channels={channels}
                firing={firingByRule.get(r.id) ?? []}
                lastFired={events.find((e) => e.ruleId === r.id || (e.ruleId === null && ruleForEvent(rules, e.signal, e.resource)?.id === r.id))}
                selected={selectedId === r.id}
                onSelect={() => onSelect(r.id)}
              />
            </li>
          ))}
        </ul>
      )}
      {shown.length < ordered.length || all ? (
        <button type="button" onClick={() => setAll((v) => !v)} className="text-muted-foreground hover:text-foreground w-fit px-1 font-mono text-[11.5px] pointer-coarse:min-h-11">
          {all ? 'Show fewer' : `Show all ${ordered.length} rules →`}
        </button>
      ) : null}
      <p className="text-muted-foreground px-1 text-xs leading-relaxed">
        A critical alert also opens an incident, so the story of what happened is kept.
      </p>
    </section>
  );
}
