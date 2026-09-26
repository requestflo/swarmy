import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { TrafficNowView } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { TextSkeleton } from '@/components/states';
import { sparkPath, trafficValue } from './app-board-words';

const W = 112;
const H = 24;

/** A tiny inline sparkline: tone-coloured when the app needs you, muted otherwise. Gaps stay gaps. */
export function Sparkline({ values, warn, label }: { values: (number | null)[]; warn: boolean; label: string }): React.JSX.Element {
  const d = sparkPath(values, W, H);
  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={label}
      className={cn('block max-w-full overflow-visible', warn ? 'text-tone-warn' : 'text-muted-foreground')}
    >
      <title>{label}</title>
      {d ? (
        <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <line x1={0} x2={W} y1={H - 2} y2={H - 2} stroke="currentColor" strokeWidth={1} strokeDasharray="2 3" opacity={0.5} />
      )}
    </svg>
  );
}

/**
 * TRAFFIC · 6 H: `traffic.series` for the sparkline and `traffic.now` for the
 * value (requests a minute at the front door). No address → nothing reaches
 * it; no edge reporting → "no data yet", never a zero.
 */
export function TrafficCell({
  app,
  hasAddress,
  now,
  warn,
  compact,
}: {
  app: string;
  hasAddress: boolean;
  now: TrafficNowView | undefined;
  warn: boolean;
  /** Just the value (the phone facts line). */
  compact?: boolean;
}): React.JSX.Element {
  const trpc = useTRPC();
  const series = useQuery({
    ...trpc.traffic.series.queryOptions({ app, window: '6h' }),
    enabled: hasAddress && !compact,
    refetchInterval: 60_000,
  });
  if (!hasAddress) return <span className="text-muted-foreground text-xs">no address</span>;
  if (!now) return <TextSkeleton className="w-20" />;
  const rate = now.totals.state === 'no-data' ? null : (now.apps.find((x) => x.app === app)?.requestsPerMin ?? 0);
  const value = trafficValue(rate);
  if (compact) return <>{value}</>;
  if (!series.data) return <TextSkeleton className="w-24" />;
  const values = series.data.points.map((p) => p.requestsPerMin);
  const known = values.filter((v): v is number => v !== null);
  const label = known.length
    ? `Requests over the last 6 hours: peak ${trafficValue(Math.max(...known))}, now ${value}`
    : 'No traffic data for the last 6 hours yet';
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <Sparkline values={values} warn={warn} label={label} />
      <span className={cn('font-mono text-[11px]', warn ? 'text-tone-warn' : 'text-muted-foreground')}>{value}</span>
    </span>
  );
}
