import * as React from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { compact, type AnalyticsView } from './rum-shared';

interface VisitorsChartProps {
  series: AnalyticsView['series'];
}

function dayLabel(day: string): string {
  const t = Date.parse(`${day.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(t)) return day;
  return new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * Visitors per day — one series, one axis, coral line. Pageviews ride in the
 * tooltip rather than on a second scale.
 */
export function VisitorsChart({ series }: VisitorsChartProps): React.JSX.Element {
  const data = series.map((s) => ({ ...s, label: dayLabel(s.day) }));
  return (
    <section className="calm-card shadow-none flex flex-col gap-2 p-5" aria-label="Visitors per day">
      <div className="flex items-center gap-2">
        <h2 className="text-base font-bold">Visitors per day</h2>
        <span className="text-muted-foreground ml-auto font-mono text-xs">
          {data[0]?.label} → {data.at(-1)?.label}
        </span>
      </div>
      <ResponsiveContainer width="100%" height={160}>
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <defs>
            <linearGradient id="rum-visitors" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-primary)" stopOpacity={0.28} />
              <stop offset="100%" stopColor="var(--color-primary)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
            interval="preserveStartEnd"
          />
          <YAxis
            width={44}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
            tickFormatter={(v: number) => compact(v)}
            tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
          />
          <Tooltip
            cursor={{ stroke: 'var(--color-muted-foreground)', strokeDasharray: '3 3' }}
            content={<DayTooltip />}
          />
          <Area
            type="monotone"
            dataKey="visitors"
            name="Visitors"
            stroke="var(--color-primary)"
            strokeWidth={2}
            fill="url(#rum-visitors)"
            activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--color-card)' }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </section>
  );
}

interface DayTooltipProps {
  active?: boolean;
  payload?: { payload: { label: string; visitors: number; pageviews: number } }[];
}

function DayTooltip({ active, payload }: DayTooltipProps): React.JSX.Element | null {
  const p = active ? payload?.[0]?.payload : undefined;
  if (!p) return null;
  return (
    <div className="bg-popover border-border rounded-lg border px-3 py-2 text-xs shadow-md">
      <div className="font-semibold">{p.label}</div>
      <div className="font-mono">{p.visitors.toLocaleString()} visitors</div>
      <div className="text-muted-foreground font-mono">{p.pageviews.toLocaleString()} pageviews</div>
    </div>
  );
}
