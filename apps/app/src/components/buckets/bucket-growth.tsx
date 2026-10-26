import * as React from 'react';
import { cn } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { TextSkeleton } from '@/components/states';
import { growthUrgent, growthWords } from './bucket-growth-model';
import { fmtBytes } from './format';
import type { GrowthRead } from './use-bucket-growth';

/** "+310 MB this week" on the size row's facts line. */
export function BucketGrowthChange({ read }: { read: GrowthRead }): React.JSX.Element | null {
  if (read.state === 'pending') return <TextSkeleton className="h-3.5 w-28" />;
  if (read.state === 'error') return <span>growth unavailable just now</span>;
  const change = growthWords(read.growth).change;
  return change ? <span className={read.growth.weekBytes > 0 ? 'text-foreground' : undefined}>{change}</span> : null;
}

/**
 * The forecast sentence (board 42): "At this rate it reaches its 50 GB
 * limit around 14 Mar", or why there's no date (flat, uneven, not enough
 * history). Amber only when a limit is reached or due within 30 days.
 */
export function BucketForecast({ read }: { read: GrowthRead }): React.JSX.Element | null {
  if (read.state !== 'ready') return null;
  const g = read.growth;
  return (
    <div className="space-y-0.5">
      <p className={cn('text-[13px] leading-relaxed', growthUrgent(g) ? 'text-tone-warn font-semibold' : 'text-muted-foreground')}>{growthWords(g).forecast}</p>
      <Tech>
        least-squares line over {g.readings} hourly reading{g.readings === 1 ? '' : 's'} ({g.spanDays.toFixed(1)} days)
        {g.r2 !== null ? ` · ${g.perDayBytes >= 0 ? '+' : '−'}${fmtBytes(Math.abs(Math.round(g.perDayBytes)))}/day · R² ${g.r2.toFixed(2)}` : ''} · a date needs 3+ days,
        24+ readings, growth over 0.5% a week and R² ≥ 0.6
      </Tech>
    </div>
  );
}
