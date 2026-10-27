import * as React from 'react';
import { Button } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { RestorePick } from './pg-restore-target';
import { isOffsite, pgCopyLine } from './pg-copy-words';
import type { PgBackupsData, PgSource } from './use-pg-backups';

/**
 * Restore from the main destination or from the second copy, when the
 * schedule has one. The copy's saves are its own (its own ids), so the restore
 * points above follow the choice. When the main destination can't be read,
 * the copy is offered.
 */
export function PgRestoreSource({ b, onFrom }: { b: PgBackupsData; onFrom: (f: PgSource) => void }): React.JSX.Element | null {
  const main = b.target;
  const dest = b.copyTarget;
  if (!main || !dest) return null;
  const offsite = isOffsite(dest);
  const copyWords = b.row?.copy ? pgCopyLine(b.row.copy, offsite).say : offsite ? 'Off-site copy' : 'Second copy';
  const unreachable = b.from === 'main' && b.catalog.isError;
  return (
    <div className="flex flex-col gap-2">
      <div role="radiogroup" aria-label="Restore from" className="flex flex-col gap-2 sm:flex-row">
        <RestorePick on={b.from === 'main'} onClick={() => onFrom('main')} title={`From ${main.name}`} sub="where every save goes first" />
        <RestorePick on={b.from === 'copy'} onClick={() => onFrom('copy')} title={`From ${dest.name}`} sub={copyWords} />
      </div>
      {unreachable ? (
        <div role="status" className="flex flex-wrap items-center gap-2">
          <span className="text-tone-warn text-[13px]">
            Couldn’t reach {main.name}. {dest.name} has its own copy of each save: restore from it.
          </span>
          <Button variant="outline" size="sm" className="pointer-coarse:min-h-11" onClick={() => onFrom('copy')}>
            Use {dest.name}
          </Button>
        </div>
      ) : null}
      <Tech>dbBackups.list · .restore · .restoreAsCopy with targetId {b.from === 'copy' ? dest.id : main.id}</Tech>
    </div>
  );
}
