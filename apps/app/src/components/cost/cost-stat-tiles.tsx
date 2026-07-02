import * as React from 'react';
import type { CostOverviewView, CostStorageView } from '@swarmy/core';
import { CountUp } from '@/components/count-up';
import { bytes } from '@/lib/format';

/**
 * Header KPI tiles: estimated monthly total, allocated share, storage
 * footprint and idle-service count. Big mono numbers per Hot Signal.
 */

function Tile({
  label,
  value,
  caption,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  caption?: string;
  tone?: 'warning';
}): React.JSX.Element {
  return (
    <div className="card-pop p-5">
      <p className="mono-label text-muted-foreground">{label}</p>
      <p
        className={`mono-data mt-1 text-3xl font-bold sm:text-4xl ${tone === 'warning' ? 'text-status-warning' : ''}`}
      >
        {value}
      </p>
      {caption ? <p className="text-muted-foreground mt-1 hidden text-xs sm:block">{caption}</p> : null}
    </div>
  );
}

export function CostStatTiles({
  overview,
  storage,
}: {
  overview: CostOverviewView;
  storage: CostStorageView | undefined;
}): React.JSX.Element {
  const { totals } = overview;
  const storageValue =
    storage == null
      ? '…'
      : storage.garageState === 'ready'
        ? bytes(storage.usageBytes)
        : '—';
  const storageCaption =
    storage == null
      ? undefined
      : storage.garageState === 'ready'
        ? `${storage.bucketCount} bucket${storage.bucketCount === 1 ? '' : 's'} · ${storage.volumeCount} volume${storage.volumeCount === 1 ? '' : 's'}`
        : storage.volumeCount > 0
          ? `object store ${storage.garageState} · ${storage.volumeCount} volumes`
          : `object store ${storage.garageState}`;

  return (
    <div className="mb-8 grid grid-cols-2 gap-4 xl:grid-cols-4">
      <Tile
        label="Est. monthly"
        value={
          <CountUp value={totals.monthlyUsd} format={(n) => `$${Math.round(n).toLocaleString()}`} />
        }
        caption={`${totals.pricedNodes}/${totals.totalNodes} nodes priced`}
      />
      <Tile
        label="Allocated to stacks"
        value={
          <CountUp
            value={totals.allocatedUsd}
            format={(n) => `$${Math.round(n).toLocaleString()}`}
          />
        }
        caption={
          totals.monthlyUsd > 0
            ? `${Math.round((totals.allocatedUsd / totals.monthlyUsd) * 100)}% of spend — the rest is headroom`
            : 'set node costs to see this'
        }
      />
      <Tile label="Storage" value={storageValue} caption={storageCaption} />
      <Tile
        label="Idle services"
        value={<CountUp value={totals.idleServiceCount} />}
        caption={totals.idleServiceCount > 0 ? 'averaging under 2% CPU' : 'nothing idling'}
        tone={totals.idleServiceCount > 0 ? 'warning' : undefined}
      />
    </div>
  );
}
