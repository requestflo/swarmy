import * as React from 'react';
import { HistoryIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { DbRestoreDialog } from '@/components/stacks/db-restore-dialog';
import { SAFETY_COPY_WORDS, isSafetyCopy } from '@/components/stacks/db-backup-format';
import { fmtBytes } from './backup-format';
import { failureWords } from './backup-words';
import { DownloadSnapshotSheet } from './download-snapshot-sheet';
import { RestoreSnapshotConfirm } from './restore-snapshot-confirm';
import type { GridCell, GridLane } from './restore-grid-model';

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const hm = (ms: number): string => new Date(ms).toISOString().slice(11, 16);

function day(ms: number): string {
  const d = new Date(ms);
  return `${WEEKDAY[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`;
}

/** What the picked cell is, in one line: size · how it went · where it is. */
function metaLine(cell: GridCell): string {
  const s = cell.save;
  const how =
    cell.state === 'retried'
      ? `first try failed, retried ${hm(s.atMs)} · saved`
      : cell.state === 'failed'
        ? 'didn’t save'
        : cell.state === 'running'
          ? 'saving now'
          : 'saved';
  const why = isSafetyCopy(s) ? SAFETY_COPY_WORDS : null;
  return [why, s.sizeBytes ? fmtBytes(s.sizeBytes) : null, how, s.where ? `in ${s.where}` : null].filter(Boolean).join(' · ');
}

/** The picked restore point: what it is, and the ways to put it back. */
export function RestorePointDetail({ lane, cell }: { lane: GridLane; cell: GridCell }): React.JSX.Element {
  const s = cell.save;
  const usable = cell.state === 'ok' || cell.state === 'retried';
  const [stack = '', cluster = ''] = lane.kind === 'db' ? lane.ref.split('/') : [];
  return (
    <div className="bg-surface-2/60 dark:bg-accent/40 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl px-4 py-3">
      <HistoryIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[14px] font-semibold">
          {usable ? 'Restore' : 'Save of'} {lane.name} {usable ? 'to' : 'on'} {day(s.atMs)}, {hm(s.atMs)} UTC
        </span>
        <span className="text-muted-foreground font-mono text-[11.5px]">{metaLine(cell)}</span>
        {cell.state === 'failed' ? <span className="text-tone-bad text-[13px]">{failureWords(s.error)}</span> : null}
        <Tech>
          {lane.kind === 'controller' ? 'controller bundle' : lane.kind === 'db' ? `db:${lane.ref}` : lane.ref} · {s.id.slice(0, 8)}
          {cell.attempts.length > 1 ? ` · ${cell.attempts.length} attempts that day` : ''}
          {s.error ? ` · ${s.error}` : ''}
        </Tech>
      </div>
      {usable && lane.kind === 'volume' ? <DownloadSnapshotSheet snapshotId={s.id} volume={lane.ref} /> : null}
      {usable && lane.kind === 'volume' ? <RestoreSnapshotConfirm snapshotId={s.id} volume={lane.ref} /> : null}
      {usable && lane.kind === 'db' ? (
        <DbRestoreDialog
          stack={stack}
          cluster={cluster}
          targetId={s.whereId}
          backup={{ id: s.id, time: new Date(s.atMs).toISOString(), engine: s.engine ?? null, sizeBytes: s.sizeBytes, tags: [`db:${lane.ref}`], reason: s.reason ?? null }}
        />
      ) : null}
      {usable && lane.kind === 'controller' ? (
        <Button asChild variant="outline" size="sm" className="pointer-coarse:min-h-11">
          <a href="#swarmy-itself">How to put swarmy back</a>
        </Button>
      ) : null}
    </div>
  );
}
