import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { HardDriveIcon } from 'lucide-react';
import { Badge, Card, CardContent, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { untilTime } from './backup-format';
import { AutoBackupBadge } from './auto-backup-badge';

/** `backups.autoCoverage().volumes` — a plain named volume and its default backup. */
export interface CoverageVolume {
  volume: string;
  service: string;
  status: 'auto' | 'user' | 'opted-out' | 'unscheduled';
  optOut: 'app' | 'volume' | null;
  retentionDays: number | null;
  nextRunAt: string | null;
  secondaryTargetId: string | null;
}

/**
 * Every other named volume of the app gets a nightly copy by default
 * (crash-consistent). Minimal on purpose: one on/off for the app and one per
 * volume (the `swarmy.backup.auto` / `.exclude` labels). Deliberately plain
 * while the dashboard redesign lands.
 */
export function StackVolumeCoverageCard({
  stack,
  volumes,
  appOptedOut,
}: {
  stack: string;
  volumes: CoverageVolume[];
  appOptedOut: boolean;
}): React.JSX.Element | null {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const set = useMutation(
    trpc.backups.setAutoVolumeBackup.mutationOptions({
      onSuccess: (r) => {
        toast.success(
          `${r.volume ?? 'Volume backups'} ${r.enabled ? 'back on' : 'off'} — takes effect within a few minutes`,
        );
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  if (volumes.length === 0) return null;
  return (
    <Card className="card-pop border-0">
      <CardContent className="p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
          <span className="mono-label">Volumes — nightly copy by default</span>
          <button
            type="button"
            className="text-primary text-xs font-bold hover:underline"
            disabled={set.isPending}
            onClick={() => set.mutate({ stack, enabled: appOptedOut })}
          >
            {appOptedOut ? 'Turn on for this app' : 'Turn off for this app'}
          </button>
        </div>
        <div className="divide-border divide-y border-t">
          {volumes.map((v) => (
            <div key={v.volume} className="flex flex-wrap items-center gap-4 px-6 py-3">
              <HardDriveIcon className="text-muted-foreground size-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="mono-data truncate font-medium">{v.volume}</p>
                <p className="text-muted-foreground mono-label truncate">
                  {v.service}
                  {v.secondaryTargetId ? ' · also copied off-site' : ''}
                  {v.nextRunAt ? ` · next ${untilTime(v.nextRunAt)}` : ''}
                </p>
              </div>
              {v.status === 'auto' && <AutoBackupBadge retentionDays={v.retentionDays} />}
              {v.status === 'user' && <Badge variant="success">Scheduled</Badge>}
              {v.status === 'opted-out' && <Badge variant="muted">Off</Badge>}
              {v.status === 'unscheduled' && <Badge variant="warning">Not backed up yet</Badge>}
              {v.optOut !== 'app' && !appOptedOut && v.status !== 'user' && (
                <button
                  type="button"
                  className="text-primary text-xs font-bold hover:underline"
                  disabled={set.isPending}
                  onClick={() => set.mutate({ stack, volume: v.volume, enabled: v.status === 'opted-out' })}
                >
                  {v.status === 'opted-out' ? 'Turn on' : 'Turn off'}
                </button>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
