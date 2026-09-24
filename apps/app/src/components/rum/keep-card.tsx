import * as React from 'react';
import { RumSection, Segmented } from './rum-ui';
import { RETENTION_CHOICES, SAMPLE_CHOICES, type Footprint, type SettingsCardProps } from './rum-shared';
import { StorageForecast } from './storage-forecast';

interface KeepCardProps extends SettingsCardProps {
  footprint: Footprint | undefined;
}

const RATES = SAMPLE_CHOICES.map((v) => ({ value: v, label: `${Math.round(v * 100)}%` }));
const KEEPS = RETENTION_CHOICES.map((v) => ({ value: v, label: `${v} d` }));

/** How many sessions to record, how long to keep them, and what that costs in disk. */
export function KeepCard({ settings: s, onChange, disabled, footprint }: KeepCardProps): React.JSX.Element {
  return (
    <RumSection title="How much to keep">
      <div className="flex flex-wrap items-center gap-3">
        <span className="w-24 text-sm font-semibold">Sample</span>
        <Segmented
          label="Replay sample rate"
          value={s.replaySampleRate as (typeof SAMPLE_CHOICES)[number]}
          options={RATES}
          onChange={(replaySampleRate) => onChange({ replaySampleRate })}
          disabled={disabled}
        />
        <span className="text-muted-foreground text-xs">of identified visits are recorded</span>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="w-24 text-sm font-semibold">Keep for</span>
        <Segmented
          label="Retention"
          value={s.retentionDays as (typeof RETENTION_CHOICES)[number]}
          options={KEEPS}
          onChange={(retentionDays) => onChange({ retentionDays })}
          disabled={disabled}
        />
        <span className="text-muted-foreground text-xs">then deleted, not archived</span>
      </div>
      {s.mode !== 'identified' && s.replaySampleRate > 0 ? (
        <p className="text-status-warning text-xs">
          Replay only records in identified mode — switch the analytics mode below to start recording.
        </p>
      ) : null}
      <StorageForecast footprint={footprint} rate={s.replaySampleRate} keepDays={s.retentionDays} />
    </RumSection>
  );
}
