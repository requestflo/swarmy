import * as React from 'react';
import { maskValue, type EnvDiffRow } from '@swarmy/core';
import { Label, Switch, cn } from '@swarmy/ui';
import { TONE_DOT, TONE_TEXT, type Tone } from '@/components/calm';
import { changeGroups, type ChangeGroup } from './paste-model';

const TONE: Record<ChangeGroup['key'], Tone> = { secrets: 'mesh', added: 'ok', changed: 'warn', removed: 'bad' };

/** "What changes": the groups, each row with its value (masked when secret) and the secret/plain switch. */
export function EnvChangeGroups({
  rows,
  masked,
  onToggle,
  existingSecrets,
}: {
  rows: EnvDiffRow[];
  masked: Set<string>;
  onToggle: (key: string) => void;
  /** The service's secret variables: shown as "already a secret". */
  existingSecrets: ReadonlySet<string>;
}): React.JSX.Element {
  const groups = changeGroups(rows, existingSecrets);
  if (groups.length === 0) {
    return <p className="text-muted-foreground px-1 py-6 text-center text-[13px]">Nothing changes yet. Paste KEY=value lines on the left.</p>;
  }
  const show = (key: string, v: string | undefined): string => (v === undefined ? '' : masked.has(key) ? maskValue(v) : v);
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
              return (
                <li key={r.key} className="border-border grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 border-b py-1.5 last:border-b-0 sm:grid-cols-[13rem_minmax(0,1fr)_auto]">
                  <span className={cn('truncate font-mono text-[12.5px] font-semibold', g.key === 'removed' && 'line-through opacity-70')}>{r.key}</span>
                  <span className="text-muted-foreground col-span-2 row-start-2 truncate font-mono text-[12px] sm:col-span-1 sm:row-start-auto">
                    {g.key === 'removed'
                      ? 'will be removed'
                      : r.kind === 'changed'
                        ? secret
                          ? 'masked → new value'
                          : `${r.before} → ${r.after}`
                        : existingSecrets.has(r.key)
                          ? 'already a secret → new value'
                          : show(r.key, r.after)}
                  </span>
                  {g.key === 'removed' ? (
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
