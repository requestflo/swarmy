import * as React from 'react';
import type { OrphanSecretView } from '@swarmy/core';
import { relTime } from '@/lib/format';

/**
 * Unmanaged Docker secrets (no swarmy labels) — read-only visibility so
 * hand-made secrets aren't invisible. swarmy never touches them.
 */
export function OrphansCard({ orphans }: { orphans: OrphanSecretView[] }): React.JSX.Element | null {
  if (orphans.length === 0) return null;
  return (
    <div className="card-pop mt-6 overflow-hidden">
      <div className="border-border border-b px-5 py-3">
        <p className="text-sm font-semibold">Unmanaged secrets</p>
        <p className="text-muted-foreground text-xs">
          Created outside swarmy (docker secret create). Read-only here — no versions, no
          rotation.
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
