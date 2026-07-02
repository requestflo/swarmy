import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClockIcon } from 'lucide-react';
import { Button, Input, Label, Switch, toast } from '@swarmy/ui';
import type { DbBackupEngine } from '@swarmy/core/protocol';
import { useTRPC } from '@/integrations/trpc';
import { DbBackupCronField } from './db-backup-cron-field';

interface DbBackupScheduleProps {
  stack: string;
  cluster: string;
  /** Engine/destination/volume currently picked in the panel — saved with the schedule. */
  engine: DbBackupEngine;
  targetId: string;
  dataVolume: string;
}

/**
 * Recurring DB-backup schedule for a cluster. Docker truth: saving stamps the
 * `swarmy.db.backup.schedule` JSON label (cron/engine/retention/PITR) on the
 * cluster primary; the scheduler tick dispatches whatever is due.
 */
export function DbBackupSchedule({
  stack,
  cluster,
  engine,
  targetId,
  dataVolume,
}: DbBackupScheduleProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const schedule = useQuery(trpc.dbBackups.getSchedule.queryOptions({ stack, cluster }));
  const current = schedule.data ?? null;

  const [enabled, setEnabled] = React.useState(false);
  const [cron, setCron] = React.useState('0 3 * * *');
  const [retentionDays, setRetentionDays] = React.useState(14);
  const [pitr, setPitr] = React.useState(false);

  React.useEffect(() => {
    if (!current) return;
    setEnabled(true);
    setCron(current.cron);
    setRetentionDays(current.retentionDays);
    setPitr(current.pitr);
  }, [current]);

  const save = useMutation(
    trpc.dbBackups.setSchedule.mutationOptions({
      onSuccess: (view) => {
        toast.success(view ? `Scheduled: ${view.cron} (UTC)` : 'Schedule cleared');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const submit = (): void => {
    save.mutate(
      enabled
        ? {
            enabled: true,
            stack,
            cluster,
            cron: cron.trim(),
            engine,
            retentionDays,
            pitr,
            targetId: targetId || undefined,
            dataVolume: dataVolume.trim() || undefined,
          }
        : { enabled: false, stack, cluster },
    );
  };

  return (
    <div className="border-border space-y-3 border-t pt-5">
      <div className="flex items-center justify-between gap-3">
        <p className="mono-label text-muted-foreground flex items-center gap-1.5">
          <CalendarClockIcon className="size-3.5" /> Schedule
        </p>
        <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enable schedule" />
      </div>
      {enabled && (
        <div className="flex flex-wrap items-end gap-3">
          <DbBackupCronField cron={cron} onCron={setCron} />
          <div className="grid gap-1.5">
            <Label htmlFor="db-bkp-retention" className="mono-label">
              Keep (days)
            </Label>
            <Input
              id="db-bkp-retention"
              type="number"
              min={1}
              max={3650}
              value={retentionDays}
              onChange={(e) => setRetentionDays(Math.max(1, Number(e.target.value)))}
              className="w-24"
            />
          </div>
          <div className="grid gap-1.5 pb-2">
            <Label className="mono-label">PITR (WAL archive)</Label>
            <Switch checked={pitr} onCheckedChange={setPitr} aria-label="Enable point-in-time recovery" />
          </div>
        </div>
      )}
      <div className="flex items-center gap-3">
        <Button variant="outline" onClick={submit} disabled={save.isPending || schedule.isPending}>
          Save schedule
        </Button>
        {current?.nextRunAt && (
          <p className="text-muted-foreground mono-label">
            Next run {new Date(current.nextRunAt).toLocaleString()}
          </p>
        )}
      </div>
    </div>
  );
}
