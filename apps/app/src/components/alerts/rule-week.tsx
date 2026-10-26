import * as React from 'react';
import { selectorKey, type AlertEventView, type AlertRuleView } from '@swarmy/core';
import { CardSkeleton } from '@/components/states';
import { RuleBacktestChart } from './rule-backtest-chart';
import { RuleHistoryChart } from './rule-history-chart';
import { weekHistory } from './rule-history';
import { phraseFor } from './signal-phrases';
import type { RuleDraft } from './use-rule-draft';
import { BACKTEST_SIGNALS, useRuleBacktest } from './use-rule-backtest';

interface RuleWeekProps {
  rule: AlertRuleView | null;
  draft: RuleDraft;
  base: RuleDraft;
  events: AlertEventView[];
  /** The event page came back full (200), so the week may be cut short. */
  pageFull: boolean;
}

/**
 * The editor's "Last 7 days · real data". Error-rate, disk and queue-depth
 * rules replay the week against the threshold and duration in the editor ("would have fired
 * N×"); every other signal shows what really fired, and says plainly that a
 * backtest isn't available once there's a setting to test.
 */
export function RuleWeek({ rule, draft, base, events, pageFull }: RuleWeekProps): React.JSX.Element {
  const source = useRuleBacktest(draft.signal, draft.selector);
  const changed = !rule || draft.threshold !== base.threshold || draft.forSeconds !== base.forSeconds;
  if (source.state === 'pending') return <CardSkeleton />;
  if (source.state === 'ready') {
    const asSaved = rule !== null && !changed && selectorKey(draft.selector) === selectorKey(base.selector);
    // Every rule owns its events (Q10); only pre-Q10 rows are ruleless.
    const own = rule ? events.filter((e) => e.ruleId === rule.id || e.ruleId === null) : [];
    return (
      <RuleBacktestChart
        signal={draft.signal}
        grid={source.grid}
        subjects={source.subjects}
        threshold={draft.threshold}
        forSeconds={draft.forSeconds}
        tech={source.tech}
        realFires={asSaved ? weekHistory(own, draft.signal, Date.now(), pageFull, draft.selector).fires.length : null}
      />
    );
  }
  const p = phraseFor(draft.signal);
  const testable = changed && (p.op !== null || p.held);
  return (
    <RuleHistoryChart
      events={events}
      signal={draft.signal}
      selector={draft.selector}
      pageFull={pageFull}
      noBacktest={BACKTEST_SIGNALS.has(draft.signal) || testable ? source.why : null}
    />
  );
}
