import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { DatabaseIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import { Section, SectionLink, Tech } from '@/components/calm';
import { engineLabel, fmtBytes } from '@/components/stacks/db-backup-format';
import { CardSkeleton } from '@/components/states';
import { agoLabel, clockLabel, momentLabel } from './time-travel-model';
import { nearestRestorePoint, pitrTarget, restoreModes } from './time-travel-replay';
import { RestoreOptions } from './restore-options';
import type { AppDatabase } from './use-time-travel';

const HATCH = {
  backgroundImage:
    'repeating-linear-gradient(135deg, color-mix(in oklch, var(--status-offline) 55%, transparent) 0 5px, color-mix(in oklch, var(--status-offline) 18%, transparent) 5px 10px)',
};

/** The saved point → now: everything an in-place restore would drop, as time (rows written aren't known). */
function LossBar({ savedAt, now, pitr }: { savedAt: number; now: number; pitr: boolean }): React.JSX.Element {
  const lost = agoLabel(savedAt, now);
  return (
    <div className="flex flex-col gap-1">
      <div aria-hidden className="bg-muted relative h-2.5 overflow-hidden rounded-full">
        <span className="bg-status-online absolute inset-y-0 left-0 w-[8%]" />
        <span className="absolute inset-y-0 right-0 left-[8%]" style={HATCH} />
      </div>
      <span className="flex justify-between gap-2 font-mono text-[11px]">
        <span className="text-muted-foreground">{pitr ? 'to' : 'saved'} {clockLabel(savedAt)}</span>
        <span className={lost === 'now' ? 'text-muted-foreground' : 'text-tone-bad'}>{lost === 'now' ? 'no writes since' : `${lost.replace(/ ago$/, '')} of writes since`}</span>
        <span className="text-muted-foreground">now {clockLabel(now)}</span>
      </span>
    </div>
  );
}

interface RestorePointCardProps {
  stack: string;
  databases: AppDatabase[];
  at: number;
  now: number;
}

/** Restore the app's database to the save nearest the head — as a copy, or in place. */
export function RestorePointCard({ stack, databases, at, now }: RestorePointCardProps): React.JSX.Element {
  const [pick, setPick] = React.useState(0);
  const db = databases[Math.min(pick, databases.length - 1)];
  const toBackups = (
    <Link to="/stacks/$name/backups" params={{ name: stack }} className="inline-flex items-center pointer-coarse:min-h-11">
      <SectionLink>Backups →</SectionLink>
    </Link>
  );
  if (!db) {
    return (
      <Section title="Restore a database" action={toBackups}>
        <p className="text-muted-foreground text-[13px]">{stack} has no managed database to put back. Its volumes are backed up on the Backups tab.</p>
      </Section>
    );
  }
  const cluster = db.row.cluster;
  const point = db.saves ? nearestRestorePoint(db.saves, at) : undefined;
  const pitr = point ? restoreModes(point.backup.engine).replace === 'pitr' : false;
  const target = point && pitr ? pitrTarget(at, db.row.pitrWindow, point.at) : point?.at;
  return (
    <Section
      title={point && target !== undefined ? `Restore ${cluster} to ${momentLabel(target)}` : `Restore ${cluster}`}
      hint={point && target !== undefined ? agoLabel(target, now) : undefined}
      action={toBackups}
    >
      {databases.length > 1 ? (
        <div role="group" aria-label="Database" className="flex flex-wrap gap-1.5">
          {databases.map((d, i) => (
            <button
              key={d.row.cluster}
              type="button"
              aria-pressed={d === db}
              onClick={() => setPick(i)}
              className={cn('h-8 rounded-lg border px-2.5 font-mono text-[12px] pointer-coarse:min-h-11', d === db ? 'border-foreground/40 bg-foreground/5' : 'border-border text-muted-foreground')}
            >
              {d.row.cluster}
            </button>
          ))}
        </div>
      ) : null}
      {db.saves === undefined ? (
        <CardSkeleton lines={3} />
      ) : !point ? (
        <p className="text-muted-foreground text-[13px]">No saves of {cluster} yet. Its first backup lands on the Backups tab.</p>
      ) : (
        <>
          <span className="flex items-center gap-2 text-[13px]">
            <DatabaseIcon aria-hidden className="text-tone-ok size-4 shrink-0" />
            {pitr ? `Recovered from the save of ${momentLabel(point.at)}` : `A full copy of ${cluster}`}
            {point.backup.sizeBytes ? ` · ${fmtBytes(point.backup.sizeBytes)}` : ''}
            {point.before ? '' : ' · the oldest save, after this moment'}
          </span>
          <Tech>
            {engineLabel(point.backup.engine)} · {point.backup.id.slice(0, 8)}
            {db.row.targetName ? ` · ${db.row.targetName}` : ''}
          </Tech>
          <LossBar savedAt={target ?? point.at} now={now} pitr={pitr} />
          <RestoreOptions stack={stack} cluster={cluster} targetId={db.row.targetId ?? undefined} backup={point.backup} savedAt={point.at} at={target ?? at} />
        </>
      )}
    </Section>
  );
}
