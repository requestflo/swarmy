import * as React from 'react';
import { CopyButton } from '@swarmy/ui';

/** Read-only host pill with a copy affordance (mirrors the managed-db panel). */
export function HostRow({ kind, host }: { kind: 'RW' | 'RO'; host: string }): React.JSX.Element {
  return (
    <div className="bg-muted/40 flex items-center justify-between gap-2 rounded-md px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="mono-label text-muted-foreground !mb-0 w-7 shrink-0">{kind}</span>
        <code className="mono-data truncate text-xs">{host}</code>
      </div>
      <CopyButton value={host} />
    </div>
  );
}

/**
 * A muted, dashed placeholder that marks where a coordinated slot mounts. Shown
 * only until the owning surface fills the slot, so the panel still reads as a
 * complete frame while the topology/backup controls are wired in.
 */
export function SlotPlaceholder({ hint }: { hint: string }): React.JSX.Element {
  return (
    <div className="border-border/60 text-muted-foreground mono-label !mb-0 rounded-lg border border-dashed px-3 py-4 text-center !text-[11px]">
      {hint}
    </div>
  );
}
