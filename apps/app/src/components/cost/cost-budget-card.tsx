import * as React from 'react';
import { monthName, monthProgress, type CostBudgetView, type CostOverviewView } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { TONE_DOT, TONE_TEXT, Tech, type Tone } from '@/components/calm';
import { usd } from './use-cost-budget';

const STATE_TONE: Record<'ok' | 'warn' | 'over', Tone> = { ok: 'ok', warn: 'warn', over: 'bad' };

/**
 * Board 50's estimate card: the month's projected cost against the budget, a
 * used % pill, a bar with the warn marker, and one plain line. Every number
 * is the monthly run rate from server prices — never a bill.
 */
export function CostBudgetCard({ o, budget }: { o: CostOverviewView; budget: CostBudgetView | undefined }): React.JSX.Element {
  const now = new Date();
  const { day } = monthProgress(now);
  const s = budget?.status ?? null;
  const tone = s ? STATE_TONE[s.state] : 'idle';
  const priced = o.totals.pricedNodes < o.totals.totalNodes ? ` (${o.totals.pricedNodes} of ${o.totals.totalNodes} priced)` : '';
  return (
    <section aria-label="This month" className="calm-card flex flex-col gap-3 px-5 py-4">
      <span className="calm-eyebrow text-muted-foreground">{`${monthName(now)} · estimate`}</span>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-display text-[40px] leading-none font-bold tracking-tight">{usd(o.totals.monthlyUsd)}</span>
          <span className="text-muted-foreground text-[15px]">{s ? `of ${usd(s.budgetUsd)} budget` : 'a month · no budget yet'}</span>
        </p>
        {s ? (
          <span className={cn('rounded-full border px-2.5 py-0.5 font-mono text-[12px] font-semibold', TONE_TEXT[tone], 'border-current/30')}>
            {s.usedPct}% used
          </span>
        ) : null}
      </div>
      {s ? <BudgetBar usedPct={s.usedPct} warnPct={s.warnPct} tone={tone} /> : null}
      <p className="text-muted-foreground text-[13.5px] leading-relaxed">
        {`Servers ${usd(o.totals.monthlyUsd)}${priced} · ${day} days in · on track to land at ${usd(o.totals.monthlyUsd)}`}
        {' — prices come from your server labels, not a bill.'}
      </p>
      <Tech>{`sum of swarmy.node.cost over priced servers = monthly run rate${s ? ` · ${s.projectedUsd}/${s.budgetUsd} = ${s.usedPct}% · state ${s.state}` : ''}`}</Tech>
    </section>
  );
}

/** The bar: used share filled in the state's tone; a tick at the warn %. Capped at 100% wide. */
function BudgetBar({ usedPct, warnPct, tone }: { usedPct: number; warnPct: number; tone: Tone }): React.JSX.Element {
  const warnAt = Math.min(100, Math.max(0, warnPct));
  return (
    <div className="flex flex-col gap-1">
      <div
        role="meter"
        aria-label="Share of the monthly budget"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(usedPct, 100)}
        className="bg-secondary relative h-2.5 w-full rounded-full"
      >
        <span className={cn('absolute inset-y-0 left-0 rounded-full', TONE_DOT[tone])} style={{ width: `${Math.min(usedPct, 100)}%` }} />
        {warnAt < 100 ? <span aria-hidden className="bg-tone-warn absolute -inset-y-1 w-0.5 rounded" style={{ left: `${warnAt}%` }} /> : null}
      </div>
      <div className="relative h-4" aria-hidden>
        <span className="text-tone-warn absolute font-mono text-[11px] whitespace-nowrap" style={{ left: `${warnAt}%`, transform: `translateX(${warnAt > 85 ? '-100%' : '-50%'})` }}>
          {warnPct}% warn
        </span>
      </div>
    </div>
  );
}
