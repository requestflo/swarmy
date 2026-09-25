import * as React from 'react';
import type { DbTopologyMode } from '@swarmy/core';
import { DbBackupPanel } from './db-backup-panel';
import { DbTopologySelector } from './db-topology-selector';

interface DbClusterRowDetailProps {
  stack: string;
  cluster: string;
  topology?: DbTopologyMode;
}

/**
 * The deeper cluster controls — every topology (incl. geo / active-active)
 * and the backup engine, schedule and restores. Rendered at Controls depth
 * (it replaces the old "Topology & backups ▸" disclosure).
 */
export function DbClusterRowDetail({ stack, cluster, topology }: DbClusterRowDetailProps): React.JSX.Element {
  return (
    <div className="grid min-w-0 items-start gap-4 2xl:grid-cols-2 [&>*]:min-w-0">
      <DbTopologySelector stack={stack} cluster={cluster} current={topology ? { topology } : undefined} />
      <DbBackupPanel stack={stack} cluster={cluster} />
    </div>
  );
}
