import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LoaderCircleIcon } from 'lucide-react';
import { Button, toast } from '@swarmy/ui';
import { Section } from '@/components/calm';
import { RestoreCopyStatus } from '@/components/backups/restore-copy-status';
import { useRestoreCopy } from '@/components/backups/use-restore-copy';
import { useTRPC } from '@/integrations/trpc';
import { fmtBytes, isPhysical } from '@/components/stacks/db-backup-format';
import { clampPit, formatPit, pitSpan, spanDays } from './pitr-scrub';
import { PgScrubber } from './pg-scrubber';
import { PgWindowNote } from './pg-window-note';
import { PgRestoreTarget, type RestoreTarget } from './pg-restore-target';
import { pointTime } from './retention-strip';
import type { PgBackupsData } from './use-pg-backups';

interface PgRestoreProps {
  stack: string;
  cluster: string;
  b: PgBackupsData;
  /** The restore point picked on the keep strip (logical saves). */
  selected: string | null;
  /** Coral only when the page shows no other next action. */
  primary: boolean;
}

/**
 * Restore: to any second in the PITR window (physical engines, the scrubber),
 * or from the picked saved copy (logical), into a NEW database it creates
 * beside this one (`dbBackups.restoreAsCopy`) or in place behind a typed
 * confirm (`dbBackups.restore`, mode `pitr` or `in-place`).
 */
export function PgRestore({ stack, cluster, b, selected, primary }: PgRestoreProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const s = b.schedule;
  // The agent's read of the WAL repo when there is one, else the estimate.
  const from = b.pitrWindow?.from;
  const to = b.pitrWindow?.to;
  const span = React.useMemo(() => (from && to ? pitSpan({ from, to }) : null), [from, to]);
  const pitr = span != null && s != null && isPhysical(s.engine);
  const [pit, setPit] = React.useState<number | null>(null);
  const at = span ? clampPit(pit ?? span.toMs, span) : null;
  // Clone / in-place restores take logical saves only (the agent refuses a physical one).
  const logical = b.points.filter((p) => !p.engine || !isPhysical(p.engine));
  const point = logical.find((p) => p.id === selected) ?? logical[0] ?? null;
  const [target, setTarget] = React.useState<RestoreTarget>('new');
  const [confirm, setConfirm] = React.useState('');
  const ref = `${stack}/${cluster}`;
  const copy = useRestoreCopy(stack, cluster);

  const restore = useMutation(
    trpc.dbBackups.restore.mutationOptions({
      onSuccess: () => {
        toast.success(`Restored ${cluster}`);
        setConfirm('');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(`Restore of ${cluster} failed`, { description: e.message, duration: 10_000 }),
    }),
  );
  const run = (): void => {
    const what =
      pitr && at != null && s
        ? { engine: s.engine, targetTime: new Date(at).toISOString() }
        : point
          ? { engine: point.engine ?? 'pg_dump', snapshotId: point.id }
          : null;
    if (!what) return;
    if (target === 'new') return copy.restore.mutate({ stack, cluster, ...what, name: copy.name });
    restore.mutate({ stack, cluster, ...what, ...(pitr ? { mode: 'pitr' as const, dataVolume: s?.dataVolume ?? undefined } : { mode: 'in-place' as const }) });
  };
  const ready = (pitr || point != null) && (target === 'in' ? confirm.trim() === ref : copy.ready);
  const pending = restore.isPending || copy.running != null;
  const when = pitr && at != null ? formatPit(at) : point ? `${pointTime(Date.parse(point.time))} UTC` : null;
  const done = restore.data;

  return (
    <Section
      id={`restore-${cluster}`}
      title={pitr ? 'Restore to a point in time' : 'Restore a saved copy'}
      count={pitr && span ? `any second in the last ${spanDays(span)} days` : point ? `from the save of ${pointTime(Date.parse(point.time))} UTC` : undefined}
    >
      {pitr && span && at != null ? <PgScrubber span={span} value={at} onChange={setPit} /> : null}
      {pitr && span ? (
        <PgWindowNote span={span} source={b.pitrWindowSource} checked={s?.engine === 'wal-g' && !b.pitrReadUnsupported} unsupported={b.pitrReadUnsupported} />
      ) : null}
      {!pitr && s?.pitr ? (
        <p className="text-muted-foreground text-[13px]">Restoring to any second opens once the first base copy has saved.</p>
      ) : null}
      {!pitr && !point ? (
        <p className="text-muted-foreground text-[13px]">Nothing to restore yet: no saved copies of {cluster}.</p>
      ) : (
        <>
          <PgRestoreTarget
            stack={stack} cluster={cluster} target={target} onTarget={setTarget}
            copyName={copy.name} confirm={confirm} onConfirm={setConfirm}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant={target === 'in' ? 'destructive' : primary ? 'default' : 'outline'}
              disabled={!ready || pending}
              onClick={run}
            >
              {target === 'in' ? 'Restore in place' : `Restore into ${copy.name}`}
            </Button>
            <span className="text-muted-foreground font-mono text-[11.5px]">
              {target === 'in' ? 'typed confirm · audited' : `no downtime for ${cluster}`}
            </span>
          </div>
        </>
      )}
      <RestoreCopyStatus stack={stack} cluster={cluster} copy={copy} what={when ? `${cluster} as of ${when}` : undefined} />
      {restore.isPending ? (
        <p role="status" className="text-muted-foreground flex items-center gap-2 text-[13px]">
          <LoaderCircleIcon aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />
          Restoring {cluster} to {when}… Backing up {cluster} first, then replacing it.
        </p>
      ) : done ? (
        <p role="status" className="text-tone-ok text-[13px]">
          Restored {fmtBytes(done.bytesRestored)} into {cluster}{done.recoveredTo ? `, up to ${done.recoveredTo}` : ''}.
          {done.safetySnapshotId ? ` What was there before is backed up as ${done.safetySnapshotId.slice(0, 8)}: restore that to put it back.` : ''}
        </p>
      ) : null}
    </Section>
  );
}
