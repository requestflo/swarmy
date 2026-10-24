import * as React from 'react';
import { Input, cn } from '@swarmy/ui';
import { Tech } from '@/components/calm';

export type RestoreTarget = 'new' | 'in';

interface PgRestoreTargetProps {
  stack: string;
  cluster: string;
  target: RestoreTarget;
  onTarget: (t: RestoreTarget) => void;
  /** The database "into a new cluster" creates (`useRestoreCopy`). */
  copyName: string;
  confirm: string;
  onConfirm: (v: string) => void;
}

function Pick({ on, onClick, title, sub }: { on: boolean; onClick: () => void; title: string; sub: React.ReactNode }): React.JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={cn(
        'flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-xl border px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
        on ? 'border-primary/70 bg-primary/[0.05] shadow-[0_0_0_3px_color-mix(in_oklab,var(--primary)_12%,transparent)]' : 'hover:border-input',
      )}
    >
      <b className="text-[14px] font-semibold">{title}</b>
      <span className="text-muted-foreground text-[12.5px] leading-snug">{sub}</span>
    </button>
  );
}

/** Where the restore lands: a new database it creates beside this one (compare first), or this one (its current data is backed up first). */
export function PgRestoreTarget(p: PgRestoreTargetProps): React.JSX.Element {
  const ref = `${p.stack}/${p.cluster}`;
  return (
    <div className="flex flex-col gap-2.5">
      <div role="radiogroup" aria-label="Where to restore" className="flex flex-col gap-2 sm:flex-row">
        <Pick
          on={p.target === 'new'}
          onClick={() => p.onTarget('new')}
          title="Into a new cluster"
          sub={<>creates <span className="font-mono">{p.copyName}</span> · nothing changes until you switch {p.stack} to it</>}
        />
        <Pick on={p.target === 'in'} onClick={() => p.onTarget('in')} title="In place" sub={`replaces ${p.cluster} · its current data is backed up first`} />
      </div>
      {p.target === 'in' ? (
        <Input
          value={p.confirm}
          onChange={(e) => p.onConfirm(e.target.value)}
          aria-label={`Type ${ref} to confirm`}
          placeholder={`type ${ref} to confirm`}
          className="max-w-sm font-mono"
          autoComplete="off"
          spellCheck={false}
        />
      ) : null}
      <Tech>
        {p.target === 'in'
          ? `dbBackups.restore · into ${ref} itself, after a reason:pre-restore backup (refused if it fails)`
          : `dbBackups.restoreAsCopy · creates ${p.stack}/${p.copyName} (1 copy, same image and placement), wired into no app · remove it with db.remove`}
      </Tech>
    </div>
  );
}
