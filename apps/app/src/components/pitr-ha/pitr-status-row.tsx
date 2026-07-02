import * as React from 'react';
import { HistoryIcon } from 'lucide-react';
import { StatusBadge, type StatusTone } from '@swarmy/ui';
import type { DbWalShipperView } from '@swarmy/core';

/**
 * One-line PITR status for the cluster panel: whether WAL archiving is
 * requested (`swarmy.db.backup.pitr`) and whether the per-cluster wal-shipper
 * sidecar is actually pushing segments to S3. Off-state teaches the next action.
 */
export function PitrStatusRow({
  pitr,
  shipper,
}: {
  pitr: boolean;
  shipper?: DbWalShipperView;
}): React.JSX.Element {
  let tone: StatusTone = 'neutral';
  let label = 'off';
  let note = 'Point-in-time recovery is off — enable PITR in the backup schedule below.';
  if (pitr && shipper?.status === 'running') {
    tone = 'online';
    label = 'shipping';
    note = 'WAL archiving is live — segments ship to your backup destination continuously.';
  } else if (pitr) {
    tone = 'progress';
    label = 'provisioning';
    note = 'PITR requested — the WAL shipper is being provisioned by the reconciler.';
  }
  return (
    <div className="border-border flex items-center justify-between gap-3 rounded-lg border p-3">
      <div className="flex min-w-0 items-center gap-2">
        <HistoryIcon className="text-muted-foreground size-4 shrink-0" />
        <div className="min-w-0">
          <p className="mono-label text-muted-foreground !mb-0 !text-[10px]">
            PITR · WAL archiving
          </p>
          <p className="text-muted-foreground truncate text-xs">{note}</p>
        </div>
      </div>
      <StatusBadge tone={tone} label={label} className="shrink-0" />
    </div>
  );
}
