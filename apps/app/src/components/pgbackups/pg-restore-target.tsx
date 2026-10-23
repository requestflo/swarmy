import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Input, cn } from '@swarmy/ui';
import { Depth, Tech } from '@/components/calm';

export type RestoreTarget = 'new' | 'in';

interface PgRestoreTargetProps {
  stack: string;
  cluster: string;
  target: RestoreTarget;
  onTarget: (t: RestoreTarget) => void;
  /** Other databases in this app that can take the restore. */
  siblings: string[];
  into: string | null;
  onInto: (c: string) => void;
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

/** Where the restore lands: another database in this app (compare first), or this one (its current data is backed up first). */
export function PgRestoreTarget(p: PgRestoreTargetProps): React.JSX.Element {
  const ref = `${p.stack}/${p.cluster}`;
  return (
    <div className="flex flex-col gap-2.5">
      <div role="radiogroup" aria-label="Where to restore" className="flex flex-col gap-2 sm:flex-row">
        <Pick
          on={p.target === 'new'}
          onClick={() => p.onTarget('new')}
          title="Into a new cluster"
          sub={p.into ? <><span className="font-mono">{p.into}</span> · compare, then swap. {p.cluster} keeps serving.</> : 'Needs a second database in this app to restore into.'}
        />
        <Pick on={p.target === 'in'} onClick={() => p.onTarget('in')} title="In place" sub={`replaces ${p.cluster} · its current data is backed up first`} />
      </div>
      {p.target === 'new' && !p.into ? (
        <p className="text-muted-foreground text-[13px]">
          Add an empty database to this app on its{' '}
          <Link to="/stacks/$name/data" params={{ name: p.stack }} className="text-primary hover:underline">Data tab</Link>, then restore into it.
        </p>
      ) : null}
      {p.target === 'new' && p.siblings.length > 1 ? (
        <Depth at="controls">
          <label className="flex flex-wrap items-center gap-2 text-[13px]">
            <span className="text-muted-foreground font-semibold">Restore into</span>
            <select
              value={p.into ?? ''}
              onChange={(e) => p.onInto(e.target.value)}
              className="border-input bg-background h-8 rounded-md border px-2 font-mono text-[12.5px] pointer-coarse:min-h-11"
            >
              {p.siblings.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
        </Depth>
      ) : null}
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
        dbBackups.restore · {p.target === 'in' ? `into ${ref} itself, after a reason:pre-restore backup (refused if it fails)` : `into ${p.stack}/${p.into ?? '…'} (must already be running)`}
      </Tech>
    </div>
  );
}
