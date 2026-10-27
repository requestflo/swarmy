import * as React from 'react';
import { cn } from '@swarmy/ui';
import { Depth, TONE_DOT, Tech } from '@/components/calm';
import { PgCopySelect } from './pg-copy-select';
import { isOffsite, pgCopyLine, pgCopyMethod } from './pg-copy-words';
import type { PgBackupsData } from './use-pg-backups';

/**
 * Under "Goes to": the second copy and how far it trails ("Off-site copy ·
 * 4 min behind"), or that the saves live in one place. The "Also copy to"
 * picker is at Controls.
 */
export function PgCopyLine({ stack, cluster, b }: { stack: string; cluster: string; b: PgBackupsData }): React.JSX.Element | null {
  const s = b.schedule;
  if (!s) return null;
  const copy = b.row?.copy ?? null;
  const dest = b.copyTarget;
  const line = copy && dest ? pgCopyLine(copy, isOffsite(dest)) : null;
  const method = pgCopyMethod(s.engine);
  const can = method != null;
  return (
    <div className="border-border mt-1 flex w-full min-w-0 flex-col items-start gap-1 border-t pt-2">
      {line && dest ? (
        <>
          <span className="flex max-w-full min-w-0 items-center gap-2 text-[13px]">
            <span aria-hidden className={cn('size-2 shrink-0 rounded-full', TONE_DOT[line.tone])} />
            <b className="min-w-0 leading-snug font-semibold">{line.say}</b>
          </span>
          <span className="text-muted-foreground max-w-full text-[12.5px] leading-snug">
            to {dest.name}
            {line.reach ? ` · ${line.reach}` : ''}
          </span>
          <Tech>{line.tech}</Tech>
        </>
      ) : (
        <span className="text-muted-foreground text-[12.5px] leading-snug">
          {can
            ? 'Saved in this one place. Add a second copy so losing it isn’t losing them.'
            : 'These backups live in one place: pgBackRest writes one bucket and swarmy can’t copy it.'}
        </span>
      )}
      {can ? (
        <Depth at="controls">
          <PgCopySelect stack={stack} cluster={cluster} primaryId={b.target?.id ?? null} value={s.secondaryTargetId ?? null} s3Only={method === 'walg-copy'} />
        </Depth>
      ) : null}
    </div>
  );
}
