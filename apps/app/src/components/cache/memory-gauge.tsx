import * as React from 'react';
import type { CacheStatsView } from '@swarmy/core';
import { Progress, cn } from '@swarmy/ui';
import { bytes } from '@/lib/format';

const MB = 1024 * 1024;

/**
 * Memory gauge: used_memory (last stats sample) against the declared maxmemory.
 * Warm amber past 75%, crimson past 90% — the same threshold the reconcile
 * worker alerts on.
 */
export function MemoryGauge({
  stats,
  memoryMb,
  className,
}: {
  stats: CacheStatsView | null;
  memoryMb: number;
  className?: string;
}): React.JSX.Element {
  const max = stats && stats.maxMemoryBytes > 0 ? stats.maxMemoryBytes : memoryMb * MB;
  const used = stats?.usedMemoryBytes ?? null;
  const pct = used !== null && max > 0 ? Math.min(100, (used / max) * 100) : null;
  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="mono-label text-muted-foreground !mb-0">Memory</span>
        <span className="mono-data text-xs">
          {used !== null ? bytes(used) : '—'}
          <span className="text-muted-foreground"> / {bytes(max)}</span>
        </span>
      </div>
      <Progress
        value={pct ?? 0}
        className={cn(
          'h-2',
          pct !== null && pct > 90
            ? '[&>div]:!bg-status-offline'
            : pct !== null && pct > 75
              ? '[&>div]:!bg-status-warning'
              : undefined,
        )}
      />
      {pct === null ? (
        <p className="text-muted-foreground text-[11px]">Awaiting first stats sample.</p>
      ) : null}
    </div>
  );
}
