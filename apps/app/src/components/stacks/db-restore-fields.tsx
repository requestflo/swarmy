import * as React from 'react';
import { HistoryIcon, TriangleAlertIcon } from 'lucide-react';
import { Input, Label } from '@swarmy/ui';
import type { DbRestoreMode } from '@swarmy/core/protocol';

interface RestoreFieldsProps {
  mode: DbRestoreMode;
  cluster: string;
  targetCluster: string;
  onTargetCluster: (value: string) => void;
  pitrTarget: string;
  onPitrTarget: (value: string) => void;
  database: string;
  onDatabase: (value: string) => void;
  dataVolume: string;
  onDataVolume: (value: string) => void;
}

/** Mode-specific inputs for `DbRestoreDialog` (clone / pitr / single-database / in-place). */
export function DbRestoreFields({
  mode,
  cluster,
  targetCluster,
  onTargetCluster,
  pitrTarget,
  onPitrTarget,
  database,
  onDatabase,
  dataVolume,
  onDataVolume,
}: RestoreFieldsProps): React.JSX.Element {
  return (
    <>
      {mode === 'clone-to-new-cluster' && (
        <div className="grid gap-1.5">
          <Label htmlFor="restore-target" className="mono-label">
            New cluster name
          </Label>
          <Input
            id="restore-target"
            value={targetCluster}
            onChange={(e) => onTargetCluster(e.target.value)}
            placeholder={`${cluster}-restore`}
          />
        </div>
      )}

      {mode === 'pitr' && (
        <>
          <div className="grid gap-1.5">
            <Label htmlFor="restore-pitr" className="mono-label">
              Recover to (UTC)
            </Label>
            <Input
              id="restore-pitr"
              value={pitrTarget}
              onChange={(e) => onPitrTarget(e.target.value)}
              placeholder="2026-06-30T14:00:00Z"
            />
            <p className="text-muted-foreground mono-label flex items-center gap-1.5">
              <HistoryIcon className="size-3.5" /> Latest if left blank.
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="restore-volume" className="mono-label">
              Target PGDATA volume
            </Label>
            <Input
              id="restore-volume"
              value={dataVolume}
              onChange={(e) => onDataVolume(e.target.value)}
              placeholder={`${cluster}-primary-data`}
              className="font-mono text-sm"
            />
          </div>
        </>
      )}

      {mode === 'single-database' && (
        <div className="grid gap-1.5">
          <Label htmlFor="restore-db" className="mono-label">
            Database
          </Label>
          <Input
            id="restore-db"
            value={database}
            onChange={(e) => onDatabase(e.target.value)}
            placeholder="app"
          />
        </div>
      )}

      {mode === 'in-place' && (
        <div className="border-status-offline/40 bg-status-offline/10 text-status-offline flex items-start gap-2 rounded-lg border p-3 text-sm">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
          <span>This overwrites the live primary on {cluster}. Connections drop during recovery.</span>
        </div>
      )}
    </>
  );
}
