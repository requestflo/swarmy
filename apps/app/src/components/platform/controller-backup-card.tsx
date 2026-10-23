import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { RowList, Section, SectionLink } from '@/components/calm';
import { fmtBytes, relativeTime, untilTime } from '@/components/backups/backup-format';
import { LineRow } from '@/components/rowpage/line-row';
import { CardSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';

/**
 * swarmy's own backup at a glance on the Platform page — the same reads as
 * the "swarmy itself" line on /backups (`controllerBackup.getConfig` +
 * `listSnapshots`, `backups.listTargets` for where it goes). Changing it
 * happens on /backups.
 */
export function ControllerBackupCard(): React.JSX.Element | null {
  const trpc = useTRPC();
  const config = useQuery(trpc.controllerBackup.getConfig.queryOptions());
  const snaps = useQuery({ ...trpc.controllerBackup.listSnapshots.queryOptions(), refetchInterval: 30_000 });
  const targets = useQuery(trpc.backups.listTargets.queryOptions());
  if (config.isPending || snaps.isPending) return <CardSkeleton lines={3} />;
  const c = config.data;
  if (!c || !snaps.data) return null;
  const last = snaps.data.find((s) => s.status === 'SUCCEEDED') ?? null;
  const where = targets.data?.find((t) => t.id === (last?.targetId ?? c.targetId))?.name ?? null;
  const ready = c.enabled && !!c.targetId && c.hasPassphrase;

  return (
    <Section
      title="swarmy’s own backup"
      flush
      action={
        <Link to="/backups" hash="swarmy-itself">
          <SectionLink>change →</SectionLink>
        </Link>
      }
    >
      <RowList label="swarmy’s own backup">
        <LineRow
          tone={c.enabled ? 'ok' : 'warn'}
          name="Schedule"
          say={c.enabled ? `${where ? `To ${where}` : 'No destination yet'}${c.nextRunAt ? `, next ${untilTime(c.nextRunAt)}` : ''}` : 'Paused'}
          tech={`cron ${c.schedule} · restic · encrypted`}
          word={c.enabled ? 'On' : 'Off'}
        />
        <LineRow
          tone={last ? 'ok' : 'warn'}
          name="Last backup"
          say={last ? [relativeTime(last.startedAt), last.sizeBytes ? fmtBytes(last.sizeBytes) : null].filter(Boolean).join(' · ') : 'None yet'}
          tech={last?.resticSnapshotId ? `snapshot ${last.resticSnapshotId.slice(0, 8)}` : undefined}
        />
        <LineRow
          tone={c.hasPassphrase ? 'ok' : 'warn'}
          name="Restore passphrase"
          say={c.hasPassphrase ? 'Set — swarmy can’t read it' : 'Not set: needed to rebuild swarmy on a new server'}
          word={ready ? 'Protected' : 'Needs you'}
        />
      </RowList>
    </Section>
  );
}
