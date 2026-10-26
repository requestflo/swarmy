import * as React from 'react';
import type { DbPoolerView, PoolerConfig, PoolerMode } from '@swarmy/core';
import { Button, Switch, cn } from '@swarmy/ui';
import { Depth } from '@/components/calm';
import { DEFAULT_POOLER, MODE_WORDS, POOL_SIZE_CHOICES, poolerChangeWords } from './pg-pooler-words';
import type { PgPoolerData } from './use-pg-pooler';

function Choice({ on, disabled, onClick, children }: { on: boolean; disabled: boolean; onClick: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      className={cn('min-h-9 rounded-lg border px-2.5 font-mono text-[12px] pointer-coarse:min-h-11', on ? 'bg-muted border-foreground/30 font-semibold' : 'hover:bg-muted/50')}
    >
      {children}
    </button>
  );
}

/**
 * The pooler's knobs (Controls): on/off, the mode (with what transaction
 * mode breaks, said plainly) and the pool size; then apply (`db.setPooler`),
 * which only declares it — the reconcile starts, restarts or removes it.
 */
export function PgPoolerControl({ v, p }: { v: DbPoolerView; p: PgPoolerData }): React.JSX.Element {
  const current = v.declared;
  const [draft, setDraft] = React.useState<PoolerConfig | null | undefined>(undefined);
  const shown = draft === undefined ? current : draft;
  const pick = (next: PoolerConfig | null) => setDraft(JSON.stringify(next) === JSON.stringify(current) ? undefined : next);
  const through = v.apps.filter((a) => a.via === 'pooler').length;
  const disabled = p.saving;
  const mode = shown?.mode ?? DEFAULT_POOLER.mode;
  return (
    <Depth at="controls">
      <div className="flex flex-col gap-3 border-t pt-3">
        <label className="flex min-h-11 items-center justify-between gap-3 text-[13.5px]">
          <span className="font-semibold">Pool connections with PgBouncer</span>
          <Switch checked={shown !== null} disabled={disabled} onCheckedChange={(on) => pick(on ? (current ?? DEFAULT_POOLER) : null)} aria-label="Connection pooler" />
        </label>
        {shown ? (
          <>
            <div className="flex flex-col gap-1.5">
              <span className="text-muted-foreground text-[12px]">Mode</span>
              <div role="group" aria-label="Pool mode" className="flex flex-wrap gap-1">
                {(['transaction', 'session'] as PoolerMode[]).map((m) => (
                  <Choice key={m} on={m === mode} disabled={disabled} onClick={() => pick({ ...shown, mode: m })}>
                    {MODE_WORDS[m].label}
                  </Choice>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-muted-foreground text-[12px]">Connections to the main copy, per database</span>
              <div role="group" aria-label="Pool size" className="flex flex-wrap gap-1">
                {[...new Set([...POOL_SIZE_CHOICES, shown.poolSize])].sort((a, b) => a - b).map((n) => (
                  <Choice key={n} on={n === shown.poolSize} disabled={disabled} onClick={() => pick({ ...shown, poolSize: n })}>
                    {n}
                  </Choice>
                ))}
              </div>
            </div>
          </>
        ) : null}
        {draft !== undefined ? (
          <div className="flex flex-col gap-2 rounded-xl border px-3 py-2.5">
            <p className="text-[13px]">{poolerChangeWords(current, draft, through)}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                className="pointer-coarse:min-h-11"
                disabled={disabled || (draft === null && through > 0)}
                onClick={() => p.set(draft ? { enabled: true, mode: draft.mode, poolSize: draft.poolSize } : { enabled: false })}
              >
                {p.saving ? 'Saving…' : draft ? (current ? 'Restart the pooler' : 'Start the pooler') : 'Remove the pooler'}
              </Button>
              <Button size="sm" variant="ghost" className="pointer-coarse:min-h-11" onClick={() => setDraft(undefined)}>
                Keep it as it is
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </Depth>
  );
}
