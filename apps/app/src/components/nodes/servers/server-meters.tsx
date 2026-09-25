import * as React from 'react';
import { cn } from '@swarmy/ui';
import type { NodeStatsSnapshot } from '@swarmy/core';
import { DISK_HOT_PCT } from './use-fleet';
import { gb } from './server-words';

/** One quiet usage bar: label, fill, the number. Warm once it passes `hot`. */
export function Meter({
  label,
  value,
  detail,
  hot = 90,
}: {
  label: string;
  value: number | null;
  detail?: string;
  hot?: number;
}): React.JSX.Element {
  const v = value === null ? null : Math.max(0, Math.min(100, value));
  const warm = v !== null && v >= hot;
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-3 text-[13px]">
      <span className="text-muted-foreground">{label}</span>
      <span
        role="meter"
        aria-label={`${label} use`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={v ?? undefined}
        className="bg-foreground/[0.07] h-1.5 overflow-hidden rounded-full"
      >
        {v !== null ? (
          <span
            className={cn('block h-full rounded-full', warm ? 'bg-status-warning' : 'bg-status-online/80')}
            style={{ width: `${v}%` }}
          />
        ) : null}
      </span>
      <span className={cn('font-mono text-[12px]', warm ? 'text-tone-warn' : 'text-foreground')}>
        {v === null ? '—' : `${Math.round(v)}%`}
        {detail ? <span className="text-muted-foreground hidden sm:inline"> · {detail}</span> : null}
      </span>
    </div>
  );
}

/** CPU, memory and disk now, from the latest live sample. */
export function ServerMeters({ live }: { live: NodeStatsSnapshot | null }): React.JSX.Element {
  if (!live) return <p className="text-muted-foreground text-[13px]">No live numbers while it's offline.</p>;
  const mem = live.memTotalBytes ? (live.memUsedBytes / live.memTotalBytes) * 100 : null;
  const disk = live.fsTotalBytes ? ((live.fsUsedBytes ?? 0) / live.fsTotalBytes) * 100 : null;
  return (
    <div className="grid gap-2.5">
      <Meter label="CPU" value={live.cpuPercent} />
      <Meter label="Memory" value={mem} detail={`${gb(live.memUsedBytes)} of ${gb(live.memTotalBytes)}`} />
      <Meter
        label="Disk"
        value={disk}
        hot={DISK_HOT_PCT}
        detail={live.fsTotalBytes ? `${gb(live.fsUsedBytes)} of ${gb(live.fsTotalBytes)}` : undefined}
      />
    </div>
  );
}
