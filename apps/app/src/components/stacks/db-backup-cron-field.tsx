import * as React from 'react';
import {
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@swarmy/ui';

/** Friendly cadence presets over a raw 5-field cron, with a custom escape hatch. */
const PRESETS: { cron: string; label: string }[] = [
  { cron: '0 * * * *', label: 'Every hour' },
  { cron: '0 */6 * * *', label: 'Every 6 hours' },
  { cron: '0 */12 * * *', label: 'Every 12 hours' },
  { cron: '0 3 * * *', label: 'Nightly at 03:00 UTC' },
  { cron: '0 3 * * 0', label: 'Weekly (Sun 03:00 UTC)' },
];
const CUSTOM = 'custom';

interface DbBackupCronFieldProps {
  cron: string;
  onCron: (cron: string) => void;
}

/** Cadence picker for the backup schedule (preset select + custom cron input). */
export function DbBackupCronField({ cron, onCron }: DbBackupCronFieldProps): React.JSX.Element {
  const preset = PRESETS.find((p) => p.cron === cron);
  const [custom, setCustom] = React.useState(!preset);
  const selected = custom ? CUSTOM : (preset?.cron ?? CUSTOM);

  const onSelect = (v: string): void => {
    if (v === CUSTOM) {
      setCustom(true);
      return;
    }
    setCustom(false);
    onCron(v);
  };

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="grid gap-1.5">
        <Label className="mono-label">Cadence</Label>
        <Select value={selected} onValueChange={onSelect}>
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PRESETS.map((p) => (
              <SelectItem key={p.cron} value={p.cron}>
                {p.label}
              </SelectItem>
            ))}
            <SelectItem value={CUSTOM}>Custom cron…</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {custom && (
        <div className="grid gap-1.5">
          <Label htmlFor="db-bkp-cron" className="mono-label">
            Cron (UTC)
          </Label>
          <Input
            id="db-bkp-cron"
            value={cron}
            onChange={(e) => onCron(e.target.value)}
            placeholder="0 3 * * *"
            className="w-40 font-mono text-sm"
          />
        </div>
      )}
    </div>
  );
}
