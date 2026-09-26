import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@swarmy/ui';
import { AlreadyOn, Depth, NextAction, Say, SayHeader, SectionLink } from '@/components/calm';
import { StackResilienceSection } from '@/components/resilience/stack-resilience-section';
import { CardSkeleton, ErrorState } from '@/components/states';
import { relativeTime } from './backup-format';
import { StackBackupsCode } from './stack-backups-code';
import { StackDbCoverageCard } from './stack-db-coverage-card';
import { StackVolumeCoverageCard } from './stack-volume-coverage-card';
import { StackSchedulesCard } from './stack-schedules-card';
import { StackSnapshotsCard } from './stack-snapshots-card';
import { useStackBackups } from './use-stack-backups';
import { backupsAlreadyOn } from './app-data-coverage';
import { RetryBackupAction } from './retry-backup-action';

interface StackBackupsProps {
  stack: string;
}

/**
 * The app's Backups tab: one sentence about whether its data is safe, the
 * one thing to do, its restore points; the per-volume switches, database
 * coverage and schedules at Controls. Destinations live on /backups.
 */
export function StackBackups({ stack }: StackBackupsProps): React.JSX.Element {
  const b = useStackBackups(stack);
  const [creating, setCreating] = React.useState(false);
  const [prefillVolume, setPrefillVolume] = React.useState<string | undefined>(undefined);
  const changeVolume = React.useCallback((volume: string) => {
    setPrefillVolume(volume);
    setCreating(true);
  }, []);

  if (b.pending) return <div className="grid gap-5"><CardSkeleton lines={3} /><CardSkeleton lines={5} /></div>;
  if (b.targets.isError) {
    return <ErrorState title="Couldn’t load backup destinations." error={b.targets.error} retry={() => void b.targets.refetch()} retrying={b.targets.isFetching} />;
  }

  const noHome = b.targetOptions.length === 0;
  const all = b.total > 0 && b.covered === b.total;
  const title = noHome ? (
    <>{stack} isn&apos;t backed up. <Say tone="warn">Backups have nowhere to go.</Say></>
  ) : b.failed ? (
    <>{stack}&apos;s last save failed. <Say tone="bad">The ones before it are safe.</Say></>
  ) : all ? (
    <>{stack}&apos;s data is saved nightly. <em>{b.last ? `The last save was ${relativeTime(b.last.startedAt)}.` : 'The first save lands tonight.'}</em></>
  ) : (
    <>{b.covered} of {b.total} of {stack}&apos;s stores are saved nightly. <Say tone="warn">{b.total - b.covered} aren&apos;t.</Say></>
  );
  const firstGap = b.uncovered[0];
  const gapName = firstGap ? ('name' in firstGap ? firstGap.name : firstGap.volume) : '';
  const schedules = (
    <StackSchedulesCard
            stack={stack}
            schedules={b.scheduleRows}
            targets={b.targetOptions}
            creating={creating}
            onCreatingChange={(open) => {
              setCreating(open);
              if (!open) setPrefillVolume(undefined);
            }}
            prefillVolume={prefillVolume}
            onChangeAuto={changeVolume}
            savedElsewhere={b.data.mine.filter((r) => r.scheduled).map((r) => r.cluster)}
          />
  );

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
      <div className="flex min-w-0 flex-col gap-5">
        <SayHeader
          size="md"
          title={title}
          lede={`${b.snapshotRows.length} restore point${b.snapshotRows.length === 1 ? '' : 's'}${b.destination ? `, kept in ${b.destination}` : ''}. Saves are encrypted and don’t stop the app.`}
        />
        {noHome ? (
          <NextAction title="Give backups a home" actions={<Button asChild><Link to="/backups">Set up a destination</Link></Button>}>
            {stack}&apos;s volumes and databases start saving nightly the moment a destination exists.
          </NextAction>
        ) : b.failed ? (
          <RetryBackupAction snap={b.failed} />
        ) : firstGap ? (
          <NextAction
            title={`${gapName} isn't backed up yet`}
            actions={<Button onClick={() => changeVolume(firstGap.volume ?? '')}>Schedule a nightly save</Button>}
          >
            Pick when and where; it takes a minute and doesn&apos;t stop the app.
          </NextAction>
        ) : null}
        <StackSnapshotsCard stack={stack} snapshots={b.snapshotRows} targets={b.targetOptions} />
        <Depth at="controls">
          {b.coverage?.volumes ? (
            <StackVolumeCoverageCard stack={stack} volumes={b.coverage.volumes} appOptedOut={b.coverage.appOptedOut ?? false} />
          ) : null}
          {b.coverage ? <StackDbCoverageCard stack={stack} coverage={b.coverage} onChangeVolume={changeVolume} /> : null}
        </Depth>
        {creating ? schedules : <Depth at="controls">{schedules}</Depth>}
        <StackResilienceSection stack={stack} />
      </div>
      <aside className="flex min-w-0 flex-col gap-4">
        <StackBackupsCode stack={stack} b={b} />
        <AlreadyOn
          items={backupsAlreadyOn(b.data, b.coverage)}
        />
        <Link to="/backups" className="px-1"><SectionLink>Where backups go →</SectionLink></Link>
      </aside>
    </div>
  );
}
