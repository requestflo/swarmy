import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

const PRESETS = [
  { value: '0 * * * *', label: 'Every hour' },
  { value: '0 2 * * *', label: 'Every day at 02:00' },
  { value: '0 2 * * 1', label: 'Every Monday at 02:00' },
] as const;

const CUSTOM = 'custom';

/**
 * Cron schedule editor: presets dropdown + raw 5-field cron with a live
 * "next 3 runs" preview served by `jobs.previewSchedule` (UTC).
 */
export function ScheduleField({
  value,
  onChange,
}: {
  value: string;
  onChange: (schedule: string) => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const preset = PRESETS.find((p) => p.value === value.trim())?.value ?? CUSTOM;

  const preview = useQuery({
    ...trpc.jobs.previewSchedule.queryOptions({ schedule: value.trim() || '-', count: 3 }),
    enabled: value.trim().length > 0,
  });

  return (
    <div className="grid gap-2">
      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-1.5">
          <Label>Schedule</Label>
          <Select value={preset} onValueChange={(v) => onChange(v === CUSTOM ? value : v)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRESETS.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
              <SelectItem value={CUSTOM}>Custom cron…</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="job-cron">Cron (UTC)</Label>
          <Input
            id="job-cron"
            className="font-mono"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="0 2 * * *"
          />
        </div>
      </div>

      {value.trim().length === 0 ? (
        <p className="text-muted-foreground text-xs">minute hour day-of-month month day-of-week</p>
      ) : preview.data && !preview.data.valid ? (
        <p className="text-status-offline text-xs">{preview.data.error}</p>
      ) : preview.data ? (
        <div className="text-muted-foreground text-xs">
          <span className="font-medium">{preview.data.scheduleText}</span>
          {' · next: '}
          {preview.data.next
            .map((iso) =>
              new Date(iso).toLocaleString(undefined, {
                weekday: 'short',
                hour: '2-digit',
                minute: '2-digit',
                day: 'numeric',
                month: 'short',
              }),
            )
            .join('  ·  ')}
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">Checking schedule…</p>
      )}
    </div>
  );
}
