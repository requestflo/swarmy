import * as React from 'react';
import type { DbBackupSnapshotView } from '@swarmy/core';
import { Button, Input, Label, cn } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { DbRestoreDialog } from '@/components/stacks/db-restore-dialog';
import { clockLabel, momentLabel } from './time-travel-model';
import { restoreModes } from './time-travel-replay';

type Choice = 'copy' | 'replace';

function Option({ on, onPick, title, children }: { on: boolean; onPick: () => void; title: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onPick}
      className={cn(
        'flex w-full gap-3 rounded-xl border p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        on ? 'border-foreground/45 bg-foreground/[0.04]' : 'border-border hover:bg-foreground/[0.025]',
      )}
    >
      <span aria-hidden className={cn('mt-0.5 size-4 shrink-0 rounded-full border-2', on ? 'border-foreground border-[5px]' : 'border-border')} />
      <span className="flex min-w-0 flex-col gap-1">
        <span className="text-[13.5px] font-semibold">{title}</span>
        {children}
      </span>
    </button>
  );
}

interface RestoreOptionsProps {
  stack: string;
  cluster: string;
  targetId?: string;
  backup: DbBackupSnapshotView;
  savedAt: number;
  /** Where a point-in-time restore recovers to (the head, inside the recoverable span); prefilled in the dialog. */
  at: number;
}

/**
 * Restore as a copy (safe) or replace in place, then the existing
 * `DbRestoreDialog` opens on that mode. Replacing needs the app's name typed
 * back. A managed database is not saved before an in-place restore
 * (dbBackup.service), so the page says so rather than promise it.
 */
export function RestoreOptions({ stack, cluster, targetId, backup, savedAt, at }: RestoreOptionsProps): React.JSX.Element {
  const modes = restoreModes(backup.engine);
  const [choice, setChoice] = React.useState<Choice>(modes.copy ? 'copy' : 'replace');
  const [typed, setTyped] = React.useState('');
  const pitr = modes.replace === 'pitr';
  const confirmId = React.useId();
  const mode = choice === 'copy' && modes.copy ? modes.copy : modes.replace;

  return (
    <div className="flex flex-col gap-2.5">
      <div role="group" aria-label="How to restore" className="flex flex-col gap-2">
        {modes.copy ? (
          <Option on={choice === 'copy'} onPick={() => setChoice('copy')} title={<>Restore as a copy <span className="text-tone-ok border-tone-ok/50 ml-1 rounded-md border px-1.5 py-0.5 text-[11px]">safe</span></>}>
            <span className="text-muted-foreground text-[12.5px] leading-snug">
              Loaded into a separate database beside {cluster}. Nothing changes until you switch {stack} to it.
            </span>
            <Tech>clone-to-new-cluster · loads into the cluster you name ({cluster}-restore by default); declare it on the Data tab first</Tech>
          </Option>
        ) : null}
        <Option on={choice === 'replace'} onPick={() => setChoice('replace')} title={pitr ? `Replace ${cluster} as it was at ${momentLabel(at)}` : `Replace ${cluster} in place`}>
          <span className="text-muted-foreground text-[12.5px] leading-snug">
            {pitr
              ? `Everything written to ${cluster} after ${momentLabel(at)} is gone.`
              : `Everything written to ${cluster} since ${clockLabel(savedAt)} is gone.`}{' '}
            The current data isn&rsquo;t saved first.
          </span>
          <Tech>{pitr ? `pitr · recover to ${new Date(at).toISOString()}` : 'in-place · overwrites the live primary from the dump'}</Tech>
        </Option>
      </div>
      {choice === 'replace' ? (
        <div className="grid gap-1.5">
          <Label htmlFor={confirmId} className="text-muted-foreground text-[12.5px]">
            Type <span className="text-foreground font-mono">{stack}</span> to confirm
          </Label>
          <Input id={confirmId} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={stack} autoComplete="off" spellCheck={false} />
        </div>
      ) : null}
      <DbRestoreDialog
        key={`${backup.id}-${mode}-${pitr ? at : ''}`}
        stack={stack}
        cluster={cluster}
        targetId={targetId}
        backup={backup}
        initialMode={mode}
        initialTargetTime={mode === 'pitr' ? new Date(at).toISOString() : undefined}
        trigger={
          choice === 'copy' ? (
            <Button className="w-full pointer-coarse:min-h-11">Restore as copy</Button>
          ) : (
            <Button variant="outline" disabled={typed.trim() !== stack} className="border-tone-bad text-tone-bad w-full pointer-coarse:min-h-11">
              Replace {cluster}
            </Button>
          )
        }
      />
    </div>
  );
}
