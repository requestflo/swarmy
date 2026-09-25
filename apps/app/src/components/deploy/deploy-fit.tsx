import * as React from 'react';
import { InfoIcon } from 'lucide-react';
import type { BlueprintMetaView } from '@swarmy/core';
import { useFleet } from '@/components/nodes/servers/use-fleet';
import { gb } from '@/components/nodes/servers/server-words';

/** "Fits on your servers": the template's memory against the roomiest online server. */
export function DeployFit({ template }: { template: BlueprintMetaView }): React.JSX.Element | null {
  const fleet = useFleet();
  const need = template.minMemoryMb;
  const roomiest = fleet.servers
    .filter((s) => s.node.status === 'online' && s.live?.memTotalBytes)
    .map((s) => ({ name: s.node.name, free: (s.live!.memTotalBytes - s.live!.memUsedBytes) }))
    .sort((a, b) => b.free - a.free)[0];
  if (!need || !roomiest) return null;
  const fits = roomiest.free >= need * 1024 ** 2;
  return (
    <div className="calm-card flex items-start gap-3 px-4 py-3.5">
      <InfoIcon aria-hidden className="text-tone-info mt-0.5 size-4 shrink-0" />
      <p className="text-[13.5px] leading-relaxed">
        <b className="font-semibold">{fits ? 'Fits on your servers.' : 'Tight on room.'}</b>{' '}
        <span className="text-muted-foreground">
          {template.name} needs about {need >= 1024 ? `${(need / 1024).toFixed(1)} GB` : `${need} MB`}; {roomiest.name} has{' '}
          {gb(roomiest.free)} free{fits ? '.' : '. Add a server or pick a lighter app.'}
        </span>
      </p>
    </div>
  );
}
