import * as React from 'react';
import { TriangleAlertIcon } from 'lucide-react';
import type { BlueprintMetaView } from '@swarmy/core';
import { fitsIn, useServerRoom } from '@/components/deploy/use-server-room';
import { FitBar } from './fit-bar';
import { memoryLabel } from './template-words';

/** "Fits your servers?": one bar per online server, the template's need against its free memory. */
export function FitsServers({ meta }: { meta: BlueprintMetaView }): React.JSX.Element | null {
  const room = useServerRoom();
  const need = meta.minMemoryMb;
  if (!need) return null;
  const tight = room.servers.filter((s) => !fitsIn(need, s.freeBytes));
  return (
    <div className="flex flex-col gap-2">
      <h3 className="calm-eyebrow">Fits your servers? · needs {memoryLabel(meta)}</h3>
      {room.pending ? (
        <div className="shimmer-line h-5 rounded" />
      ) : room.servers.length === 0 ? (
        <p className="text-muted-foreground text-[13px]">No server is reporting its memory yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {room.servers.map((s) => (
            <li key={s.id} className="grid grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)_auto] items-center gap-2.5 text-[12px]">
              <span className="truncate font-mono">{s.name}</span>
              <FitBar need={need} server={s} />
            </li>
          ))}
        </ul>
      )}
      {tight.length ? (
        <p className="text-tone-warn flex items-start gap-1.5 text-[12.5px] leading-snug">
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Won’t fit on {tight.map((s) => s.name).join(', ')}: needs {memoryLabel(meta)}.
            {meta.heavyReason ? ` ${meta.heavyReason.replace(/\.$/, '')}.` : ''}
          </span>
        </p>
      ) : null}
    </div>
  );
}
