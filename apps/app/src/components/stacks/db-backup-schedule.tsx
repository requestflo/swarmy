import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarClockIcon } from 'lucide-react';
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  toast,
} from '@swarmy/ui';
import {
  useDbMutation,
  useDbQuery,
  type DbBackupEngine,
  type DbBackupScheduleView,
} from './managed-db-trpc';

interface SetScheduleInput {
  stack: string;
  cluster: string;
  engine: DbBackupEngine;
  every: number;
  unit: 'hours' | 'days';
  enabled: boolean;
}

/** Recurring DB-backup schedule for a cluster (own engine + interval). */
export function DbBackupSchedule({
  stack,
  cluster,
  engine,
}: {
  stack: string;
  cluster: string;
  engine: DbBackupEngine;
}): React.JSX.Element {
  const qc = useQueryClient();
  const schedule = useDbQuery<DbBackupScheduleView | null>('dbBackup', 'getSchedule', {
    stack,
    cluster,
  });
  const current = schedule.data ?? null;

  const [enabled, setEnabled] = React.useState(false);
  const [every, setEvery] = React.useState(12);
  const [unit, setUnit] = React.useState<'hours' | 'days'>('hours');

  React.useEffect(() => {
    if (!current) return;
    setEnabled(current.enabled);
    setEvery(current.every);
    setUnit(current.unit);
  }, [current]);

  const save = useDbMutation<DbBackupScheduleView, SetScheduleInput>('dbBackup', 'setSchedule', {
    onSuccess: () => {
      toast.success(enabled ? `Backing up every ${every} ${unit}` : 'Schedule paused');
      void qc.invalidateQueries();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="border-border space-y-3 border-t pt-5">
      <div className="flex items-center justify-between gap-3">
        <p className="mono-label text-muted-foreground flex items-center gap-1.5">
          <CalendarClockIcon className="size-3.5" /> Schedule
        </p>
        <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enable schedule" />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="db-bkp-every" className="mono-label">
            Every
          </Label>
          <Input
            id="db-bkp-every"
            type="number"
            min={1}
            max={168}
            value={every}
            onChange={(e) => setEvery(Math.max(1, Number(e.target.value)))}
            className="w-24"
          />
        </div>
        <div className="grid gap-1.5">
          <Label className="mono-label">Unit</Label>
          <Select value={unit} onValueChange={(v) => setUnit(v as 'hours' | 'days')}>
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="hours">hours</SelectItem>
              <SelectItem value="days">days</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button
          variant="outline"
          onClick={() => save.mutate({ stack, cluster, engine, every, unit, enabled })}
          disabled={save.isPending}
        >
          Save schedule
        </Button>
      </div>
      {current?.nextRunAt && enabled && (
        <p className="text-muted-foreground mono-label">
          Next run {new Date(current.nextRunAt).toLocaleString()}
        </p>
      )}
    </div>
  );
}
