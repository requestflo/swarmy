import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AiUsageDayView } from '@swarmy/core';
import { CountUp } from '@/components/count-up';
import { useTRPC } from '@/integrations/trpc';

/** Tiny dependency-free day bar chart (divs only, coral bars). */
function DayBars({
  days,
  value,
  format,
}: {
  days: AiUsageDayView[];
  value: (d: AiUsageDayView) => number;
  format: (n: number) => string;
}): React.JSX.Element {
  const max = Math.max(1e-9, ...days.map(value));
  return (
    <div className="flex h-24 items-end gap-1">
      {days.map((d) => {
        const v = value(d);
        const pct = Math.max(v > 0 ? 4 : 0, Math.round((v / max) * 100));
        return (
          <div
            key={d.day}
            className="group relative flex-1"
            title={`${d.day} — ${format(v)} (${d.requests} req)`}
          >
            <div
              className="bg-primary/80 group-hover:bg-primary w-full rounded-t-sm transition-colors"
              style={{ height: `${pct}%` }}
            />
          </div>
        );
      })}
    </div>
  );
}

function Kpi({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div>
      <p className="mono-label text-muted-foreground !mb-0 !text-[10px]">{label}</p>
      <p className="mono-data text-lg">{children}</p>
    </div>
  );
}

/** Usage & cost: KPI row + per-day cost and token bars (last 14 days). */
export function UsageCharts(): React.JSX.Element {
  const trpc = useTRPC();
  const usage = useQuery({ ...trpc.ai.usage.queryOptions({ days: 14 }), refetchInterval: 10_000 });

  if (usage.isLoading) {
    return (
      <div className="card-pop space-y-3 p-5">
        <div className="shimmer-line h-5 w-40 rounded" />
        <div className="shimmer-line h-24 rounded-lg" />
      </div>
    );
  }
  const data = usage.data;
  if (!data) {
    return (
      <div className="card-pop p-5">
        <p className="text-status-offline text-sm">Couldn&apos;t load usage.</p>
      </div>
    );
  }
  const t = data.totals;

  return (
    <div className="card-pop p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-semibold">Usage &amp; cost</p>
          <p className="text-muted-foreground text-xs">
            Last 14 days · costs are estimates from a static price table.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-6 sm:grid-cols-5">
          <Kpi label="Requests">
            <CountUp value={t.requests} />
          </Kpi>
          <Kpi label="Cost (est.)">${t.costUsd.toFixed(2)}</Kpi>
          <Kpi label="Tokens">
            <CountUp value={t.inTokens + t.outTokens} />
          </Kpi>
          <Kpi label="Cache hits">
            <CountUp value={t.cacheHits} />
          </Kpi>
          <Kpi label="Avg latency">{t.avgLatencyMs}ms</Kpi>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div>
          <p className="mono-label text-muted-foreground">Cost / day (est.)</p>
          <DayBars days={data.days} value={(d) => d.costUsd} format={(n) => `$${n.toFixed(3)}`} />
        </div>
        <div>
          <p className="mono-label text-muted-foreground">Tokens / day</p>
          <DayBars
            days={data.days}
            value={(d) => d.inTokens + d.outTokens}
            format={(n) => `${Math.round(n).toLocaleString()} tok`}
          />
        </div>
      </div>

      {data.byModel.length > 0 ? (
        <div className="mt-5">
          <p className="mono-label text-muted-foreground">By model</p>
          <div className="divide-border divide-y">
            {data.byModel.slice(0, 6).map((m) => (
              <div key={m.key} className="flex items-center justify-between py-1.5 text-sm">
                <span className="mono-data truncate text-xs">{m.key}</span>
                <span className="text-muted-foreground shrink-0 text-xs">
                  {m.requests} req · ${m.costUsd.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-muted-foreground mt-5 text-sm">
          Quiet so far — point an app at the gateway and traffic lands here.
        </p>
      )}
    </div>
  );
}
