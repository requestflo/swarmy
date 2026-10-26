import * as React from 'react';
import {
  ERROR_TRIP_BASELINE_MIN,
  ERROR_TRIP_CHOICES,
  ERROR_TRIP_FACTOR,
  ERROR_TRIP_FOR_MIN,
  ERROR_TRIP_MIN_REQUESTS,
  errorTripWatchSec,
  tripPctWords,
} from '@swarmy/core';
import { Label } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { Segmented } from '@/components/service-settings/settings-row';

/** What the error trip does at this floor, in a sentence. */
export function errorTripSentence(pct: number | null, autoRollback: boolean): string {
  if (pct === null) return 'Off: only the health check judges a new version.';
  const then = autoRollback ? 'it is stopped and the last good version goes back' : 'it is marked failed';
  return `If more than ${tripPctWords(pct)} of requests fail for ${ERROR_TRIP_FOR_MIN} minutes (and ${ERROR_TRIP_FACTOR}× more than before the deploy), ${then}. Each version is watched at least ${errorTripWatchSec() / 60} min.`;
}

/**
 * "Undo if errors pass" (board 35): the error trip's floor on the app's
 * safety gate, or off. Written with the rest of `swarmy.deploy.safety`.
 */
export function ErrorTripRow({
  value,
  autoRollback,
  disabled,
  onChange,
}: {
  value: number | null;
  autoRollback: boolean;
  disabled: boolean;
  onChange: (v: number | null) => void;
}): React.JSX.Element {
  const choices = [...new Set<number>([...ERROR_TRIP_CHOICES, ...(value === null ? [] : [value])])].sort((a, b) => a - b);
  const options = [{ value: 0, label: 'Off' }, ...choices.map((p) => ({ value: p, label: tripPctWords(p) }))];
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Label className="text-sm font-medium">Undo if errors pass</Label>
          <p className="text-muted-foreground text-xs">{errorTripSentence(value, autoRollback)}</p>
        </div>
        <Segmented label="Undo if errors pass" mono options={options} value={value ?? 0} disabled={disabled} onChange={(v) => onChange(v === 0 ? null : v)} />
      </div>
      <Tech>
        {`errorTripPct ${value ?? 'null'} · 5xx share at the edge > max(${value ?? '—'}%, ${ERROR_TRIP_FACTOR}× the ${ERROR_TRIP_BASELINE_MIN} min before) for ${ERROR_TRIP_FOR_MIN} whole minutes · minutes under ${ERROR_TRIP_MIN_REQUESTS} requests don't count`}
      </Tech>
    </div>
  );
}
