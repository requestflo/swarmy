import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Label, Switch, toast } from '@swarmy/ui';
import { CalmRow, RowList, Section } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { untilTime } from './backup-format';

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

const WORD: Record<CoverageVolume['status'], string> = {
  auto: 'Nightly',
  user: 'Scheduled',
  'opted-out': 'Off',
  unscheduled: 'Not yet',
};

/**
 * Every named volume of the app gets a nightly copy by default
 * (crash-consistent). One switch for the app and one per volume — the
 * `swarmy.backup.auto` / `.exclude` labels. Rendered at Controls; Summary
 * says it in one "Already on" line.
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
        toast.success(`${r.volume ?? 'Volume backups'} ${r.enabled ? 'back on' : 'off'} — takes effect within a few minutes`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  if (volumes.length === 0) return null;
  const appId = `auto-vol-${stack}`;
  return (
    <Section
      title="Volumes"
      hint="a nightly copy of each, by default"
      flush
      action={
        <span className="flex items-center gap-2">
          <Label htmlFor={appId} className="text-muted-foreground text-xs">For this app</Label>
          <Switch id={appId} checked={!appOptedOut} disabled={set.isPending} onCheckedChange={(on) => set.mutate({ stack, enabled: on })} />
        </span>
      }
    >
      <RowList label="Volume backups">
        {volumes.map((v) => {
          const on = v.status === 'auto' || v.status === 'user';
          const canToggle = v.optOut !== 'app' && !appOptedOut && v.status !== 'user';
          return (
            <CalmRow
              key={v.volume}
              tone={on ? 'ok' : v.status === 'unscheduled' ? 'warn' : 'idle'}
              name={v.volume}
              sub={v.service}
              say={
                on
                  ? `Saved nightly${v.retentionDays ? `, kept ${v.retentionDays} days` : ''}${v.secondaryTargetId ? ', also off-site' : ''}${v.nextRunAt ? ` · next ${untilTime(v.nextRunAt)}` : ''}`
                  : v.status === 'opted-out'
                    ? v.optOut === 'app' ? 'Off for the whole app' : 'Off for this volume'
                    : 'Not backed up yet'
              }
              tech={v.status}
              word={WORD[v.status]}
              trailing={
                canToggle ? (
                  <Switch
                    aria-label={`Nightly backup of ${v.volume}`}
                    checked={v.status !== 'opted-out'}
                    disabled={set.isPending}
                    onCheckedChange={(enabled) => set.mutate({ stack, volume: v.volume, enabled })}
                  />
                ) : undefined
              }
            />
          );
        })}
      </RowList>
    </Section>
  );
}
