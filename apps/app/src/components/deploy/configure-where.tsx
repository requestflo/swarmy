import * as React from 'react';
import type { BlueprintMetaView, BlueprintPlacementView } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { gb } from '@/components/nodes/servers/server-words';
import { ConfigureField } from './configure-field';
import { ConfigureServerPicker } from './configure-server-picker';
import type { ConfigureFormState } from './use-configure-form';
import { useServerRoom } from './use-server-room';

function Choice({ on, title, sub, onPick }: { on: boolean; title: string; sub: string; onPick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onPick}
      className={cn('flex min-h-11 items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-left', on ? 'border-primary ring-primary/25 ring-2' : 'border-border hover:bg-foreground/[0.03]')}
    >
      <span aria-hidden className={cn('mt-1.5 size-2 shrink-0 rounded-full', on ? 'bg-status-online' : 'bg-status-idle')} />
      <span className="flex min-w-0 flex-col">
        <span className="text-[13.5px] font-semibold">{title}</span>
        <span className="text-muted-foreground truncate text-[12px]">{sub}</span>
      </span>
    </button>
  );
}

/**
 * Where it runs: Automatic (swarmy places it; the roomiest server named) or
 * Pick a server — every Ready server with its room, and the pick pins the app
 * there (`params.node` → `node.id==…` on its services).
 */
export function ConfigureWhere({ meta, form, placement }: { meta: BlueprintMetaView; form: ConfigureFormState; placement?: BlueprintPlacementView }): React.JSX.Element {
  const room = useServerRoom();
  const top = room.roomiest;
  const picking = form.node !== null;
  const ready = room.servers.length;
  return (
    <ConfigureField label="Where it runs">
      <div role="radiogroup" aria-label="Where it runs" className="grid gap-2 sm:grid-cols-2">
        <Choice on={!picking} title="Automatic" sub={top ? `${top.name} · most room` : room.pending ? 'finding room…' : 'swarmy picks a server with room'} onPick={() => form.setNode(null)} />
        <Choice
          on={picking}
          title="Pick a server"
          sub={room.pending ? 'checking…' : `${ready} available`}
          onPick={() => top && form.setNode(form.node ?? top.id)}
        />
      </div>
      {picking ? <ConfigureServerPicker servers={room.servers} need={meta.minMemoryMb} value={form.node} onChange={form.setNode} /> : null}
      {placement ? (
        <Tech>{`placement: ${placement.constraint} · ${placement.name}`}</Tech>
      ) : top && !picking ? (
        <Tech>{`placement: swarm scheduler · ${top.name} ${gb(top.freeBytes)} free`}</Tech>
      ) : null}
    </ConfigureField>
  );
}
