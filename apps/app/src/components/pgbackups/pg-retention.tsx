import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, toast } from '@swarmy/ui';
import { Section, TONE_TEXT, Tech } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { isPhysical } from '@/components/stacks/db-backup-format';
import { retentionChoices, retentionPreview } from './retention-preview';
import { RetentionNotch, RetentionStrip, pointTime } from './retention-strip';
import type { PgBackupsData } from './use-pg-backups';

interface PgRetentionProps {
  stack: string;
  cluster: string;
  b: PgBackupsData;
  selected: string | null;
  onSelect: (id: string) => void;
}

/**
 * "Keep restore points for": the catalog along the keep window, what a new
 * window would remove before you save it, and the save (`dbBackups.setSchedule`
 * with the schedule unchanged but `retentionDays`).
 */
export function PgRetention({ stack, cluster, b, selected, onSelect }: PgRetentionProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const s = b.schedule;
  const saved = s?.retentionDays ?? null;
  const [days, setDays] = React.useState<number>(saved ?? 14);
  React.useEffect(() => {
    if (saved != null) setDays(saved);
  }, [saved]);

  const preview = React.useMemo(
    () =>
      retentionPreview(b.points, days, {
        nowMs: Date.now(),
        nextRunMs: s?.nextRunAt ? Date.parse(s.nextRunAt) : null,
        engine: s?.engine ?? null,
      }),
    [b.points, days, s?.nextRunAt, s?.engine],
  );
  const save = useMutation(
    trpc.dbBackups.setSchedule.mutationOptions({
      onSuccess: () => {
        toast.success(`${cluster} now keeps ${days} days of restore points`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const physical = s ? isPhysical(s.engine) : false;
  const sel = preview.points.find((p) => p.id === selected) ?? preview.points.at(-1) ?? null;
  const changed = saved != null && days !== saved;
  const tone = preview.pruned ? 'warn' : 'ok';

  const say = !s
    ? 'Set a schedule first: how long to keep saves is part of it.'
    : physical
      ? `Base copies and changes go straight to the bucket and swarmy doesn’t remove them. Restores reach back ${days} days.`
      : `After each save swarmy removes saves older than ${days} days, for ${cluster} only. Each removal is in the audit log.`;

  return (
    <Section
      title="Keep restore points for"
      hint={s && !physical ? (
        <span className={TONE_TEXT[tone]}>
          {preview.pruned ? `${preview.pruned} would go at the next save` : 'nothing goes'}
        </span>
      ) : undefined}
      action={<RetentionNotch choices={retentionChoices(saved)} value={days} onChange={setDays} disabled={!s || save.isPending} />}
    >
      {preview.points.length ? (
        <RetentionStrip preview={preview} selected={sel?.id ?? null} onSelect={onSelect} />
      ) : (
        <p className="text-muted-foreground text-[13px]">
          {physical
            ? 'Base copies don’t show here: they live in the bucket, not in the list of saved copies.'
            : b.catalog.isError
              ? `Couldn’t read the saved copies: ${b.catalog.error.message}`
              : 'No saved copies yet. The first one lands at the next scheduled run.'}
        </p>
      )}
      {sel ? (
        <span className="text-muted-foreground font-mono text-[11.5px]">
          Saved {pointTime(sel.timeMs)} UTC · {sel.keep ? 'kept' : 'would go'}
        </span>
      ) : null}
      <p className="text-muted-foreground text-[13px] leading-relaxed">{say}</p>
      {s && !physical ? (
        <Tech className="[font-feature-settings:'liga'_0,'calt'_0] [font-variant-ligatures:none]">restic forget --keep-within {days}d --prune · scoped to db:{stack}/{cluster} + engine:{s.engine} · audited</Tech>
      ) : null}
      {changed && s ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={save.isPending}
            onClick={() =>
              save.mutate({
                enabled: true,
                stack,
                cluster,
                cron: s.cron,
                engine: s.engine,
                retentionDays: days,
                pitr: s.pitr,
                targetId: s.targetId ?? undefined,
                dataVolume: s.dataVolume ?? undefined,
              })
            }
          >
            {save.isPending ? 'Saving…' : `Keep ${days} days`}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setDays(s.retentionDays)}>
            Cancel
          </Button>
        </div>
      ) : null}
    </Section>
  );
}
