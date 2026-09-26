import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, toast } from '@swarmy/ui';
import { Depth, Section, Tech } from '@/components/calm';
import { QuietSwitch } from '@/components/rowpage/row-page';
import { useTRPC } from '@/integrations/trpc';
import { CostBudgetControls } from './cost-budget-controls';
import { channelWords, usd, useCostBudget } from './use-cost-budget';

/**
 * Board 50's "Budget rules" card, without the blocking row (owner decision
 * Q6: warn and summarise, never block). Summary: two sentences with switches.
 * Controls: the amount, the warn % presets, the channels and the test send.
 */
export function CostBudgetSection(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const api = useCostBudget();
  const { budget: b, channels } = api;
  const toggleRule = useMutation(
    trpc.alerts.updateRule.mutationOptions({
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: trpc.cost.pathKey() });
        void qc.invalidateQueries({ queryKey: trpc.alerts.pathKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  if (!b) {
    return (
      <Section id="budget" title="Budget">
        <div aria-hidden className="shimmer-line my-2 h-10 rounded-lg" />
      </Section>
    );
  }
  const has = b.monthlyUsd != null;
  const warnTo = channelWords(b.warnChannelIds, channels);
  const weeklyTo = channelWords(b.weeklyChannelIds, channels);
  return (
    <Section id="budget" title="Budget" hint="warns and summarises; never stops a deploy">
      <ul className="flex flex-col">
        <li className="border-border flex min-h-12 items-center gap-3 border-b py-2">
          <span className="min-w-0 flex-1 text-[14px] leading-snug">
            {has ? `Warn ${warnTo} at ${b.warnAtPct}% of ${usd(b.monthlyUsd ?? 0)}` : 'No monthly budget yet, so nothing warns about spend.'}
          </span>
          {has && b.ruleId ? (
            <QuietSwitch
              checked={b.warnEnabled}
              disabled={toggleRule.isPending}
              onCheckedChange={(enabled) => b.ruleId && toggleRule.mutate({ id: b.ruleId, enabled })}
              aria-label="Budget warning"
            />
          ) : null}
        </li>
        <li className="flex min-h-12 items-center gap-3 py-2">
          <span className="min-w-0 flex-1 text-[14px] leading-snug">
            {`Send ${weeklyTo} a weekly cost summary`}
            <span className="text-muted-foreground block text-[12.5px]">Mondays at 09:00 · {b.timeZone === 'UTC' ? 'UTC' : b.timeZone}</span>
          </span>
          <QuietSwitch
            checked={b.weeklySummary}
            disabled={api.saving}
            onCheckedChange={(weeklySummary) => api.save({ weeklySummary }, weeklySummary ? 'Weekly cost summary on.' : 'Weekly cost summary off.')}
            aria-label="Weekly cost summary"
          />
        </li>
      </ul>
      <Depth at="controls">
        <CostBudgetControls api={api} />
      </Depth>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button variant="outline" size="sm" className="pointer-coarse:min-h-11" disabled={api.sending || channels.length === 0} onClick={api.sendTest}>
          {api.sending ? 'Sending…' : 'Send a test summary'}
        </Button>
        {b.lastWeeklyAt ? <Tech>{`last weekly send ${b.lastWeeklyAt.slice(0, 16).replace('T', ' ')} UTC`}</Tech> : null}
      </div>
    </Section>
  );
}
