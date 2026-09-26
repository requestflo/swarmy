import * as React from 'react';
import { cn } from '@swarmy/ui';
import { FitBar } from '@/components/blueprints/fit-bar';
import type { ServerRoom } from './use-server-room';

/**
 * "Pick a server": every Ready server with its free memory and whether the
 * template fits, as one radio list. Picking one pins the app there.
 */
export function ConfigureServerPicker({
  servers,
  need,
  value,
  onChange,
}: {
  servers: ServerRoom[];
  need: number | undefined;
  value: string | null;
  onChange: (id: string) => void;
}): React.JSX.Element {
  if (servers.length === 0) {
    return <p className="text-muted-foreground text-[13px]">No server is ready and reporting its memory yet, so Automatic is the only choice.</p>;
  }
  return (
    <div role="radiogroup" aria-label="Pick a server" className="border-border flex flex-col overflow-hidden rounded-xl border">
      {servers.map((s, i) => {
        const on = s.id === value;
        return (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(s.id)}
            className={cn(
              'grid min-h-11 grid-cols-[1rem_minmax(0,6.5rem)_minmax(0,1fr)_auto] items-center gap-2.5 px-3.5 py-2 text-left text-[12.5px]',
              i > 0 && 'border-border border-t',
              on ? 'bg-primary/5' : 'hover:bg-foreground/[0.03]',
            )}
          >
            <span aria-hidden className={cn('flex size-3.5 items-center justify-center rounded-full border', on ? 'border-primary' : 'border-border')}>
              {on ? <span className="bg-primary size-1.5 rounded-full" /> : null}
            </span>
            <span className="truncate font-mono font-semibold">{s.name}</span>
            <FitBar need={need} server={s} />
          </button>
        );
      })}
    </div>
  );
}
