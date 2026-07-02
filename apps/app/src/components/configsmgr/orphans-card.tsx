import * as React from 'react';
import type { OrphanConfigView } from '@swarmy/core';
import { relTime } from '@/lib/format';

/**
 * Unmanaged Docker configs (no swarmy labels) — read-only visibility so
 * hand-made configs aren't invisible. swarmy never touches them.
 */
export function OrphansCard({ orphans }: { orphans: OrphanConfigView[] }): React.JSX.Element | null {
  if (orphans.length === 0) return null;
  return (
    <div className="card-pop mt-6 overflow-hidden">
      <div className="border-border border-b px-5 py-3">
        <p className="text-sm font-semibold">Unmanaged configs</p>
        <p className="text-muted-foreground text-xs">
          Created outside swarmy (docker config create). Read-only here — no versions, no diffs,
          no rollback.
        </p>
      </div>
      <div className="divide-border divide-y">
        {orphans.map((o) => (
          <div key={o.id} className="flex items-center gap-3 px-5 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="mono-data truncate text-sm">{o.name}</p>
              <p className="text-muted-foreground truncate text-xs">
                created {relTime(o.createdAt)}
                {o.consumers.length > 0 ? ` · used by ${o.consumers.join(', ')}` : ' · unused'}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
