import * as React from 'react';
import { ShieldCheckIcon } from 'lucide-react';
import { Tech } from '@/components/calm';
import type { HostBlocked } from '@/lib/host-blocked';
import { blockedWords } from './blocked-words';

/**
 * "Blocked N a minute" over the protection cards (board 30), from the edge's
 * own count for this address. Nothing renders without an honest number.
 */
export function BlockedReceipt({ blocked, host, service }: { blocked: HostBlocked | null; host: string; service: string }): React.JSX.Element | null {
  const w = blockedWords(blocked, host, service);
  if (!w) return null;
  return (
    <div className="border-border flex flex-col gap-1 rounded-[10px] border px-3 py-2" aria-label="Blocked at the front door">
      <p className="flex flex-wrap items-baseline gap-x-1.5 text-[12.5px] leading-snug">
        <ShieldCheckIcon aria-hidden className="text-tone-ok size-3.5 shrink-0 self-center" />
        <span className="font-mono text-[13px] font-semibold">{w.head}</span>
        <span className="text-muted-foreground">{w.note}</span>
      </p>
      <Tech>{w.tech}</Tech>
    </div>
  );
}
