import type * as React from 'react';
import type { DbWalCheckView } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { TONE_DOT, TONE_TEXT, Tech } from '@/components/calm';
import { walLine } from './wal-check';

/**
 * Board 40's "WAL continuous · 0 gaps", from the agent's `wal-g wal-verify`
 * (`dbBackups.walCheck`): the archive since when, or the gap a restore can't
 * land inside. Quiet until there is a read; the read itself at Controls.
 */
export function PgWalLine({ check }: { check: DbWalCheckView | null | undefined }): React.JSX.Element | null {
  const line = walLine(check);
  if (!line) return null;
  return (
    <p role={line.tone === 'ok' ? undefined : 'status'} className="flex flex-col gap-1 text-[13px]">
      <span className="flex items-start gap-2">
        <span aria-hidden className={cn('mt-1.5 size-2 shrink-0 rounded-full', TONE_DOT[line.tone])} />
        <span className={line.tone === 'ok' ? 'text-muted-foreground' : TONE_TEXT[line.tone]}>{line.text}</span>
      </span>
      <Tech>dbBackups.walCheck · {line.tech}</Tech>
    </p>
  );
}
