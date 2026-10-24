import * as React from 'react';
import { CopyButton } from '@swarmy/ui';
import type { ClusterZoneView } from './geo-types';

/**
 * The records the registrar (or a sub-zone's parent DNS) needs so swarmy-dns
 * answers the cluster zone: one NS per pinned nameserver, plus its glue A.
 */
export function ClusterZoneGlue({ zone, glue }: { zone: string; glue: ClusterZoneView['glue'] }): React.JSX.Element {
  if (glue.length === 0) {
    return (
      <p className="text-muted-foreground text-[13px]">
        Pick the servers that answer for {zone} at Controls (Nameservers). The records to add at your registrar appear here.
      </p>
    );
  }
  const sub = zone.split('.').length > 2;
  return (
    <div className="flex flex-col gap-1.5">
      <p className="mono-label text-muted-foreground">{sub ? `In the DNS for ${zone.split('.').slice(1).join('.')}` : 'At your registrar'}</p>
      <div className="border-border divide-border divide-y rounded-xl border">
        {glue.map((r) => (
          <div key={`${r.name} ${r.type} ${r.value}`} className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-1.5 font-mono text-[12px]">
            <span className="min-w-0 basis-full truncate sm:flex-1 sm:basis-auto">{r.name}.</span>
            <span className="text-muted-foreground w-8 shrink-0">{r.type}</span>
            <span className="min-w-0 flex-1 truncate font-semibold sm:flex-none">{r.type === 'NS' ? `${r.value}.` : r.value}</span>
            <CopyButton value={r.value} className="size-7 pointer-coarse:size-11" />
          </div>
        ))}
      </div>
    </div>
  );
}
