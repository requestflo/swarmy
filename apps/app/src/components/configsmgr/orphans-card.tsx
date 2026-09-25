import * as React from 'react';
import type { OrphanConfigView } from '@swarmy/core';
import { Section } from '@/components/calm';
import { relTime } from '@/lib/format';

/**
 * Unmanaged Docker configs (no swarmy labels) — read-only visibility so
 * hand-made configs aren't invisible. swarmy never touches them.
 */
export function OrphansCard({ orphans }: { orphans: OrphanConfigView[] }): React.JSX.Element | null {
  if (orphans.length === 0) return null;
  return (
    <Section title="Config files made outside swarmy" count={orphans.length} hint="docker config create · read-only" flush>
      <div className="divide-border divide-y">
        {orphans.map((o) => (
          <div key={o.id} className="flex min-h-12 items-center gap-3 px-1 py-2">
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
    </Section>
  );
}
