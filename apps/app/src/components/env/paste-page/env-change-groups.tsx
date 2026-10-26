import * as React from 'react';
import { LockIcon } from 'lucide-react';
import { maskValue } from '@swarmy/core';
import { Label, Switch, cn } from '@swarmy/ui';
import { TONE_DOT, TONE_TEXT, type Tone } from '@/components/calm';
import { changeGroups, type ChangeGroup } from './paste-model';
import type { PasteRow } from './paste-target';

const TONE: Record<ChangeGroup['key'], Tone> = { secrets: 'mesh', added: 'ok', changed: 'warn', removed: 'bad', locked: 'idle', kept: 'info' };

/** What a row's value column says. */
function valueWords(g: ChangeGroup['key'], r: PasteRow, secret: boolean, existing: boolean): string {
  if (g === 'removed') return 'will be removed';
  if (g === 'locked') return 'declared in swarmy.yaml; change it there';
  if (g === 'kept') return `${r.why ?? 'sets its own'} · keeps ${secret ? 'its value' : (r.before ?? '')}`;
  if (r.kind === 'changed') return secret ? 'masked → new value' : `${r.before} → ${r.after}`;
  if (existing) return 'already a secret → new value';
  return r.after === undefined ? '' : secret ? maskValue(r.after) : r.after;
}

/** "What changes": the groups, each row with its value (masked when secret) and the secret/plain switch; locked rows say where swarmy.yaml sets them. */
export function EnvChangeGroups({
  rows,
  masked,
  onToggle,
  existingSecrets,
}: {
  rows: PasteRow[];
  masked: Set<string>;
  onToggle: (key: string) => void;
  /** The service's secret variables: shown as "already a secret". */
  existingSecrets: ReadonlySet<string>;
}): React.JSX.Element {
  const groups = changeGroups(rows, existingSecrets);
  if (groups.length === 0) {
    return <p className="text-muted-foreground px-1 py-6 text-center text-[13px]">Nothing changes yet. Paste KEY=value lines on the left.</p>;
  }
  return (
    <div className="flex flex-col">
      {groups.map((g) => (
        <div key={g.key} className="flex flex-col">
          <div className="flex items-center gap-2 pt-3 pb-1 text-[12.5px]">
            <span aria-hidden className={cn('size-2 rounded-full', TONE_DOT[TONE[g.key]])} />
            <span className={g.key === 'removed' ? TONE_TEXT.bad : 'text-muted-foreground'}>{g.title}</span>
            <span className="text-muted-foreground font-mono text-[11px]">{g.rows.length}</span>
          </div>
          <ul className="flex flex-col">
            {g.rows.map((r) => {
              const secret = masked.has(r.key);
              const id = `secret-${r.key}`;
              const still = g.key === 'removed' || g.key === 'locked' || g.key === 'kept';
              return (
                <li key={r.key} className="border-border grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 border-b py-1.5 last:border-b-0 sm:grid-cols-[13rem_minmax(0,1fr)_auto]">
                  <span className={cn('truncate font-mono text-[12.5px] font-semibold', g.key === 'removed' && 'line-through opacity-70', g.key === 'locked' && 'opacity-70')}>{r.key}</span>
                  <span className="text-muted-foreground col-span-2 row-start-2 flex min-w-0 flex-col font-mono text-[12px] sm:col-span-1 sm:row-start-auto">
                    <span className="truncate">{valueWords(g.key, r, secret, existingSecrets.has(r.key))}</span>
                    {g.key === 'locked' && r.why ? <span className="truncate text-[11px] opacity-80">{r.why}</span> : null}
                  </span>
                  {g.key === 'locked' ? (
                    <LockIcon aria-label="Locked: swarmy.yaml sets it" className="text-muted-foreground size-3.5" />
                  ) : still ? (
                    <span />
                  ) : (
                    <span className="flex items-center gap-1.5">
                      {r.secret ? <span className="text-tone-warn hidden text-[11px] md:inline">looks like a secret</span> : null}
                      <Switch id={id} checked={secret} onCheckedChange={() => onToggle(r.key)} aria-label={`Keep ${r.key} as a secret`} />
                      <Label htmlFor={id} className="text-muted-foreground w-11 text-[11px] font-normal">
                        {secret ? 'secret' : 'plain'}
                      </Label>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
