import * as React from 'react';
import { cn } from '@swarmy/ui';
import { gb } from '@/components/nodes/servers/server-words';
import { fitsIn, type ServerRoom } from '@/components/deploy/use-server-room';

/**
 * One server's fit for a template: the need as a share of its free memory,
 * then "3.1 GB free · fits" (or won't fit, in amber). Two grid cells, so a
 * list lines its bars up; shared by "Fits your servers?" and the server picker.
 */
export function FitBar({ need, server }: { need: number | undefined; server: ServerRoom }): React.JSX.Element {
  const fits = fitsIn(need, server.freeBytes);
  const pct = need ? Math.min(100, Math.round(((need * 1024 ** 2) / Math.max(1, server.freeBytes)) * 100)) : 0;
  return (
    <>
      <span className="bg-muted h-1.5 overflow-hidden rounded-full" aria-hidden>
        <span className={cn('block h-full rounded-full', fits ? 'bg-status-online' : 'bg-status-warning')} style={{ width: `${pct}%` }} />
      </span>
      <span className={cn('font-mono text-[11.5px] whitespace-nowrap', fits ? 'text-tone-ok' : 'text-tone-warn')}>
        {gb(server.freeBytes)} free{need ? ` · ${fits ? 'fits' : "won't fit"}` : ''}
      </span>
    </>
  );
}
