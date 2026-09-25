import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Depth, Section, StatusWord } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { relativeTime } from '@/components/backups/backup-format';
import { BackupNowButton } from './backup-now-button';
import { ReplicationCard } from './replication-card';
import { PassphraseCard } from './passphrase-card';
import { ScheduleCard } from './schedule-card';
import { SnapshotsList } from './snapshots-list';

/**
 * "swarmy itself": the controller's own state. A sentence at Summary; the
 * live copy, passphrase, schedule and bundle list at Controls.
 */
export function ControllerSection(): React.JSX.Element {
  const trpc = useTRPC();
  const config = useQuery(trpc.controllerBackup.getConfig.queryOptions());
  const c = config.data;
  const ready = !!c?.enabled && !!c.targetId && c.hasPassphrase;
  const say = !c
    ? 'Checking…'
    : ready
      ? `Settings, people and history are saved ${c.lastRunAt ? `(last ${relativeTime(c.lastRunAt)})` : '(no run yet)'}, sealed with your passphrase, so you can rebuild swarmy on a new server.`
      : !c.hasPassphrase
        ? 'Not protected yet. Set a restore passphrase so swarmy itself can be rebuilt if every server is lost.'
        : 'Not scheduled yet. Pick where swarmy’s own backup goes.';
  return (
    <Section
      id="swarmy-itself"
      title="swarmy itself"
      action={
        <span className="flex items-center gap-2">
          {c ? <StatusWord tone={ready ? 'ok' : 'warn'} word={ready ? 'Protected' : 'Needs you'} /> : null}
          <BackupNowButton />
        </span>
      }
    >
      <p className="text-muted-foreground text-[13.5px] leading-relaxed">{say}</p>
      <Depth at="controls">
        <div className="grid gap-4 pt-2">
          <ReplicationCard />
          <PassphraseCard />
          <ScheduleCard />
          <SnapshotsList />
        </div>
      </Depth>
    </Section>
  );
}
