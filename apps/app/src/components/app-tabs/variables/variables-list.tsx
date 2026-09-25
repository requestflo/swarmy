import * as React from 'react';
import { maskValue, type InvService } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { Depth, Tech } from '@/components/calm';
import { shortName } from '../use-stack-services';
import { PasteEnvButton } from './paste-env-button';
import type { VarOrigin, VarRow } from './variables-model';

const ORIGIN: Record<VarOrigin, { word: string; cls: string }> = {
  you: { word: 'you', cls: 'text-muted-foreground' },
  binding: { word: 'from a connection', cls: 'text-tone-info' },
  swarmy: { word: 'swarmy', cls: 'text-tone-ok' },
};

/** Plain variables, one row per name across the app; values that look like passwords stay masked. */
export function VariablesList({
  stack,
  rows,
  services,
}: {
  stack: string;
  rows: VarRow[];
  services: InvService[];
}): React.JSX.Element {
  return (
    <div className="flex flex-col">
      {rows.length === 0 ? (
        <p className="text-muted-foreground py-3 text-[13.5px]">
          No plain variables yet. Paste a .env into a service and swarmy rolls it out.
        </p>
      ) : (
        <ul aria-label="Plain variables" className="flex flex-col">
          {rows.map((r) => (
            <VarLine key={r.key} row={r} total={services.length} />
          ))}
        </ul>
      )}
      <Depth at="controls">
        <div className="border-border flex flex-wrap items-center gap-1 border-t pt-2 pb-1.5">
          {services.map((s) => (
            <PasteEnvButton key={s.id} serviceId={s.id} label={shortName(stack, s.name)} />
          ))}
        </div>
      </Depth>
    </div>
  );
}

function VarLine({ row, total }: { row: VarRow; total: number }): React.JSX.Element {
  const origin = ORIGIN[row.origin];
  const shown = row.value === null ? 'differs by service' : row.secretLooking ? maskValue(row.value) : row.value;
  return (
    <li className="border-border grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 border-b py-2 last:border-b-0 sm:grid-cols-[14rem_minmax(0,1fr)_auto]">
      <span className="truncate font-mono text-[12.5px] font-semibold">{row.key}</span>
      <span
        className={cn(
          'col-span-2 row-start-2 truncate font-mono text-[12.5px] sm:col-span-1 sm:row-start-auto',
          row.value === null && 'text-muted-foreground font-sans',
        )}
      >
        {shown}
        {row.secretLooking ? <span className="text-tone-warn ml-2 font-sans text-xs">looks like a password</span> : null}
      </span>
      <span className="text-right text-xs">
        <span className={origin.cls}>{origin.word}</span>
        <span className="text-muted-foreground"> · {row.services.length === total && total > 1 ? 'all' : row.services.join(', ')}</span>
      </span>
      {row.origin === 'binding' ? (
        <span className="col-span-full">
          <Tech>swarmy fills this in on each deploy, so the password never leaves the swarm</Tech>
        </span>
      ) : null}
    </li>
  );
}
