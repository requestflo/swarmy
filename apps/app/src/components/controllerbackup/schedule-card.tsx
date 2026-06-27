import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DatabaseBackupIcon } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusBadge,
  Switch,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/**
 * Schedule + target. Daily by default, kept 7d / 4w / 3m, stored to a backup
 * target shared with volume backups. The "back up now" action lives in the page
 * header as the single coral CTA.
 */
export function ScheduleCard(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const config = useQuery(trpc.controllerBackup.getConfig.queryOptions());
  const targets = useQuery(trpc.backups.listTargets.queryOptions());

  const setConfig = useMutation(
    trpc.controllerBackup.setConfig.mutationOptions({
      onSuccess: () => qc.invalidateQueries(),
      onError: (e) => toast.error(e.message),
    }),
  );

  const enabled = config.data?.enabled ?? false;
  const targetId = config.data?.targetId ?? '';
  const canRun = Boolean(targetId) && (config.data?.hasPassphrase ?? false);

  return (
    <Card className="card-pop border-0">
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <DatabaseBackupIcon className="size-4" /> Schedule
          </CardTitle>
          <CardDescription>
            Daily by default, kept 7d / 4w / 3m, stored to a backup target (shared with volume
            backups). Runs on the controller — secrets never leave it.
          </CardDescription>
        </div>
        <StatusBadge
          tone={enabled ? 'online' : 'neutral'}
          label={enabled ? 'scheduled' : 'paused'}
        />
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        <div className="flex flex-wrap items-end gap-6">
          <div className="flex items-center gap-2 pb-2">
            <Switch
              checked={enabled}
              onCheckedChange={(v) => setConfig.mutate({ enabled: v })}
              disabled={!canRun}
            />
            <Label className="mono-label">Enabled</Label>
          </div>
          <div className="grid min-w-[14rem] gap-1.5">
            <Label className="mono-label">Backup target</Label>
            <Select value={targetId} onValueChange={(v) => setConfig.mutate({ targetId: v })}>
              <SelectTrigger>
                <SelectValue placeholder="Pick a target" />
              </SelectTrigger>
              <SelectContent>
                {(targets.data ?? []).map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name} ({t.kind})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {!canRun ? (
          <p className="text-muted-foreground text-xs">
            Set a passphrase and pick a target to enable backups.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
