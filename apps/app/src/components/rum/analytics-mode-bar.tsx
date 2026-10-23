import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Chip, Segmented } from './rum-ui';
import type { RumSettings } from './rum-shared';
import { useIsOrgAdmin, useSaveRumSettings } from './use-rum';

interface AnalyticsModeBarProps {
  stack: string;
  settings: RumSettings | undefined;
  days: number;
  onDays: (d: number) => void;
}

const DAY_OPTIONS = [
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
];

const MODE_OPTIONS: { value: RumSettings['mode']; label: string }[] = [
  { value: 'analytics', label: 'Privacy mode' },
  { value: 'identified', label: 'Identified mode' },
];

/**
 * Which mode the app counts in, switchable right here: privacy mode is
 * cookieless and aggregate; identified mode ties visits to signed-in people
 * (personal data). Saving is the `swarmy.rum` label — the edge picks it up on
 * the next page view, no redeploy. Owners and admins only.
 */
export function AnalyticsModeBar({ stack, settings: s, days, onDays }: AnalyticsModeBarProps): React.JSX.Element {
  const admin = useIsOrgAdmin();
  const { save, pending } = useSaveRumSettings(stack);
  const identified = s?.mode === 'identified';
  return (
    <div className="flex flex-wrap items-center gap-3">
      {s ? (
        <span title={admin ? undefined : 'Owners and admins can change the mode'}>
          <Segmented
            label="Analytics mode"
            value={s.mode}
            options={MODE_OPTIONS}
            disabled={!admin || pending}
            onChange={(mode) => mode !== s.mode && save(s, { mode })}
          />
        </span>
      ) : null}
      {identified ? (
        <Chip tone="warning">personal data · consent needed</Chip>
      ) : (
        <Chip tone="online">cookieless · no personal data</Chip>
      )}
      <span className="text-muted-foreground min-w-0 text-sm">
        {identified
          ? 'Visits tied to signed-in users, with sessions and replays.'
          : 'Aggregate counts only. No cookies, nothing stored on the device.'}
      </span>
      <div className="ml-auto flex items-center gap-2">
        <Segmented label="Time range" value={days} options={DAY_OPTIONS} onChange={onDays} />
        <Link
          to="/stacks/$name/rum-settings"
          params={{ name: stack }}
          className="border-border hover:bg-accent rounded-full border px-3 py-1 text-xs font-semibold"
        >
          Settings
        </Link>
      </div>
    </div>
  );
}
