import * as React from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export interface TrendSeries {
  key: string;
  color: string;
  label: string;
}

export function AreaTrend({
  data,
  series,
  height = 220,
  yMax,
  unit = '',
}: {
  data: Record<string, number | string>[];
  series: TrendSeries[];
  height?: number;
  yMax?: number;
  unit?: string;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
        <defs>
          {series.map((s) => (
            <linearGradient key={s.key} id={`grad-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
        <XAxis dataKey="t" hide />
        <YAxis
          domain={[0, yMax ?? 'auto']}
          width={48}
          tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
          tickFormatter={(v) => `${v}${unit}`}
        />
        <Tooltip
          contentStyle={{
            background: 'var(--color-popover)',
            border: '1px solid var(--color-border)',
            borderRadius: 8,
            fontSize: 12,
          }}
          formatter={(v: number) => `${Number(v).toFixed(1)}${unit}`}
        />
        {series.map((s) => (
          <Area
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.label}
            stroke={s.color}
            strokeWidth={2}
            fill={`url(#grad-${s.key})`}
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Accumulate a polled value into a fixed-length rolling window. */
export function useRolling<T>(value: T | undefined, max = 60): T[] {
  const [series, setSeries] = React.useState<T[]>([]);
  React.useEffect(() => {
    if (value === undefined) return;
    setSeries((prev) => [...prev, value].slice(-max));
  }, [value, max]);
  return series;
}
