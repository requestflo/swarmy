import * as React from 'react';
import { CodeView, Section, Tech } from '@/components/calm';
import { humanBytes } from '@/components/stack-data/pg-choices';
import { engineLabel, isPhysical } from '@/components/stacks/db-backup-format';
import { primaryService, renderedDbLabels } from './pg-labels';
import { pgCopyMethod } from './pg-copy-words';
import type { PgBackupsData } from './use-pg-backups';

interface PgAsideProps {
  stack: string;
  cluster: string;
  b: PgBackupsData;
}

/** The rendered `swarmy.db.backup.*` labels and the live schedule, at Code. */
export function PgLabelsCode({ stack, cluster, b }: PgAsideProps): React.JSX.Element {
  const s = b.schedule;
  const live = JSON.stringify(
    { schedule: s, pitrWindow: b.pitrWindow ?? null, pitrWindowSource: b.pitrWindowSource, savedCopies: b.points.length },
    null,
    2,
  );
  return (
    <CodeView
      title={`${cluster} backups as labels`}
      tabs={[
        { label: 'Labels', code: renderedDbLabels(s, primaryService(stack, cluster)) },
        { label: 'Live', code: live },
      ]}
      source="readonly"
      note="Read-only: the labels swarmy keeps on the primary. Changing the schedule or the keep window rewrites them."
    />
  );
}

function Row({ k, v, tech }: { k: string; v: React.ReactNode; tech?: string }): React.JSX.Element {
  return (
    <div className="border-border flex flex-col gap-0.5 border-b py-2 last:border-b-0">
      <div className="flex items-baseline gap-3 text-[13px]">
        <span className="text-muted-foreground w-28 shrink-0 text-[12.5px] font-semibold">{k}</span>
        <span className="min-w-0">{v}</span>
      </div>
      {tech ? <Tech className="pl-31">{tech}</Tech> : null}
    </div>
  );
}

/** Where the second copy is and how it is made: wal-g copies each base backup with the changes since it. */
function secondCopy(b: PgBackupsData): [string, string | undefined] {
  const s = b.schedule;
  const method = s ? pgCopyMethod(s.engine) : null;
  if (!s) return ['not on a schedule', undefined];
  if (!method) return ['none: pgBackRest writes one bucket', undefined];
  if (!b.copyTarget) return ['none yet: these saves live in one place', undefined];
  return method === 'walg-copy'
    ? [`in ${b.copyTarget.name}: each base copy and the changes since it`, 'wal-g copy --backup-name <base> after each base backup · a restore from it reaches the last copy']
    : [`in ${b.copyTarget.name}: every save, made again there`, 'a second db.backup after each save'];
}

/** "What gets saved": the copy, the changes between copies, the lock on it, and the list. */
export function PgSavedCard({ stack, cluster, b }: PgAsideProps): React.JSX.Element {
  const s = b.schedule;
  const physical = s ? isPhysical(s.engine) : false;
  const size = humanBytes(b.row?.lastSizeBytes ?? null);
  const [copyWords, copyTech] = secondCopy(b);
  return (
    <Section title="What gets saved" count={cluster}>
      <div className="flex flex-col">
        <Row
          k="Full copy"
          v={s ? `${engineLabel(s.engine)}${size ? ` · last one ${size}` : ''}` : 'not on a schedule'}
          tech={s ? (physical ? 'base backup pushed straight to the bucket' : 'dump → restic snapshot') : undefined}
        />
        <Row
          k="Every change"
          v={s?.pitr ? 'kept between copies, to the second' : 'not kept: restores go back to a full copy'}
          tech={s?.pitr ? 'WAL archive → wal-shipper → wal-g wal-push' : 'no swarmy.db.backup.pitr label'}
        />
        <Row k="Second copy" v={copyWords} tech={copyTech} />
        <Row
          k="Encryption"
          v={physical ? 'as private as the bucket it goes to' : 'locked with your backup key before it leaves'}
          tech={physical ? 'wal-g / pgBackRest write the bucket directly' : 'restic · AES-256'}
        />
        <Row
          k="Saved copies"
          v={physical ? `${b.points.length} in the list, plus the base copies in the bucket` : `${b.points.length} in the list`}
          tech={`restic tag db:${stack}/${cluster}${physical ? ' · wal-g keeps its own backup list' : ''}`}
        />
      </div>
      {!physical ? (
        <p className="text-muted-foreground text-xs leading-relaxed">
          Any restic binary can restore these with the repository password, with or without swarmy.
        </p>
      ) : null}
    </Section>
  );
}
