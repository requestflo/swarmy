import * as React from 'react';
import { Chip, Segmented } from './rum-ui';

interface AnalyticsModeBarProps {
  identified: boolean;
  days: number;
  onDays: (d: number) => void;
}

const DAY_OPTIONS = [
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
];

/**
 * Which mode the app counts in, said plainly: privacy mode is cookieless and
 * aggregate; identified mode ties visits to signed-in people (personal data).
 */
export function AnalyticsModeBar({ identified, days, onDays }: AnalyticsModeBarProps): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {identified ? (
        <Chip tone="warning">Identified mode · personal data, consent needed</Chip>
      ) : (
        <Chip tone="online">Privacy mode · cookieless, no personal data</Chip>
      )}
      <span className="text-muted-foreground text-sm">
        {identified
          ? 'Visits tied to signed-in users, with sessions and replays.'
          : 'Aggregate counts only. No cookies, nothing stored on the device.'}
      </span>
      <div className="ml-auto flex items-center gap-2">
        <Segmented label="Time range" value={days} options={DAY_OPTIONS} onChange={onDays} />
      </div>
    </div>
  );
}
