import * as React from 'react';
import { Tech } from '@/components/calm';

/** One settings row of a cache (board 41): label · value · tech line. */
export function Kv({ k, children, tech }: { k: string; children: React.ReactNode; tech?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="border-border flex flex-col gap-1 border-t py-2.5 sm:flex-row sm:items-start sm:gap-4">
      <span className="text-muted-foreground w-28 shrink-0 text-[13px]">{k}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {children}
        {tech ? <Tech>{tech}</Tech> : null}
      </div>
    </div>
  );
}
