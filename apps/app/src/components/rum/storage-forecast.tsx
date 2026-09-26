import * as React from 'react';
import { bytes, compact, type Footprint } from './rum-shared';

interface StorageForecastProps {
  footprint: Footprint | undefined;
  rate: number;
  keepDays: number;
}

/** Without history yet, assume a typical compressed replay. */
const TYPICAL_SESSION_BYTES = 180 * 1024;

/**
 * Forecast from what's actually stored: yesterday's recordings (or, before
 * any, yesterday's visitors × the chosen sample) × the average recorded
 * session, kept for the chosen days.
 */
export function StorageForecast({ footprint: f, rate, keepDays }: StorageForecastProps): React.JSX.Element {
  if (!f) {
    return (
      <p className="text-muted-foreground text-xs">
        The forecast appears once the observability store has a day of visits.
      </p>
    );
  }
  const avg = f.replaySessions > 0 ? f.replayBytes / f.replaySessions : TYPICAL_SESSION_BYTES;
  // Only signed-in visits record, so yesterday's actual recordings are the honest base; all visitors × rate is the fallback.
  const measured = f.replaySessions24h > 0;
  const perDay = measured ? f.replaySessions24h : Math.round(f.visitors24h * rate);
  const dayBytes = perDay * avg;
  const kept = dayBytes * keepDays;
  return (
    <div className="flex flex-col gap-2 pt-1">
      <div className="flex flex-wrap gap-6">
        <Stat value={compact(perDay)} label="sessions / day" />
        <Stat value={bytes(dayBytes)} label="recordings / day · object storage" />
        <Stat value={bytes(kept)} label={`kept at ${keepDays} days`} />
        <Stat value={bytes(f.replayBytes)} label={`stored now · ${compact(f.replaySessions)} sessions`} />
      </div>
      <p className="text-muted-foreground text-xs">
        Based on {measured ? `${compact(f.replaySessions24h)} recorded in the last 24 h` : `${compact(f.visitors24h)} visitors in the last 24 h`} and {bytes(avg)} per recorded session.
      </p>
      {rate >= 1 && keepDays >= 30 ? (
        <p className="text-tone-warn text-xs">
          100% for {keepDays} days keeps more replays than you'll ever watch. 10% is usually plenty to find a bug.
        </p>
      ) : null}
    </div>
  );
}

function Stat({ value, label }: { value: string; label: string }): React.JSX.Element {
  return (
    <span className="flex flex-col">
      <span className="font-display text-xl font-bold">{value}</span>
      <span className="text-muted-foreground font-mono text-[10.5px]">{label}</span>
    </span>
  );
}
