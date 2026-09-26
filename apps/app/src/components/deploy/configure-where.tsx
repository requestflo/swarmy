import * as React from 'react';
import { cn } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { gb } from '@/components/nodes/servers/server-words';
import { ConfigureField } from './configure-field';
import { useServerRoom } from './use-server-room';

/**
 * Where it runs: Automatic (swarmy places it; the roomiest server named) or
 * Pick a server — shown, not built yet (server pinning is an open decision).
 */
export function ConfigureWhere(): React.JSX.Element {
  const room = useServerRoom();
  const top = room.roomiest;
  return (
    <ConfigureField label="Where it runs">
      <div role="radiogroup" aria-label="Where it runs" className="grid gap-2 sm:grid-cols-2">
        <div role="radio" aria-checked="true" className="border-primary ring-primary/25 flex min-h-11 items-start gap-2.5 rounded-xl border px-3.5 py-2.5 ring-2">
          <span aria-hidden className="bg-status-online mt-1.5 size-2 shrink-0 rounded-full" />
          <span className="flex min-w-0 flex-col">
            <span className="text-[13.5px] font-semibold">Automatic</span>
            <span className="text-muted-foreground truncate text-[12px]">
              {top ? `${top.name} · most room` : room.pending ? 'finding room…' : 'swarmy picks a server with room'}
            </span>
          </span>
        </div>
        <div role="radio" aria-checked="false" aria-disabled="true" className={cn('border-border flex min-h-11 items-start gap-2.5 rounded-xl border px-3.5 py-2.5 opacity-60')}>
          <span aria-hidden className="bg-status-idle mt-1.5 size-2 shrink-0 rounded-full" />
          <span className="flex min-w-0 flex-col">
            <span className="text-[13.5px] font-semibold">Pick a server</span>
            <span className="text-muted-foreground text-[12px]">coming soon</span>
          </span>
        </div>
      </div>
      {top ? <Tech>{`placement: swarm scheduler · ${top.name} ${gb(top.freeBytes)} free`}</Tech> : null}
    </ConfigureField>
  );
}
