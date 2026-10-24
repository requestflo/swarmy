import * as React from 'react';
import { Tech } from '@/components/calm';

interface KvProps {
  k: string;
  children: React.ReactNode;
  /** A mono tech line under the value (shown at Controls). */
  tech?: React.ReactNode;
  /** A quiet action at the row's end (Rotate, Edit). */
  action?: React.ReactNode;
}

/** One labelled row of a search block, as board 41 lays them out. */
export function Kv({ k, children, tech, action }: KvProps): React.JSX.Element {
  return (
    <div className="border-border flex flex-col gap-1 border-t py-2.5 sm:flex-row sm:items-start sm:gap-4">
      <span className="text-muted-foreground w-28 shrink-0 text-[13px]">{k}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {children}
        {tech ? <Tech>{tech}</Tech> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/** Field names as quiet mono chips; an empty list says so. */
export function FieldChips({ fields, empty }: { fields: string[]; empty: string }): React.JSX.Element {
  if (fields.length === 0) return <span className="text-muted-foreground text-[13px]">{empty}</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {fields.map((f) => (
        <code key={f} className="bg-muted rounded px-1.5 py-0.5 font-mono text-[11.5px]">
          {f}
        </code>
      ))}
    </span>
  );
}
