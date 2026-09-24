import * as React from 'react';
import { HardDriveIcon } from 'lucide-react';
import type { AppEnvironment } from './gitops-types';
import { PurgeDataDialog } from './purge-data-dialog';
import { envLabel } from './plan-status';

interface AppKeptVolumesProps {
  repoId: string;
  environments: AppEnvironment[];
}

/**
 * Removed Postgres whose data is still on disk (AppView keptVolumes) — one
 * line each with "Delete data permanently". Gone once purged.
 */
export function AppKeptVolumes({
  repoId,
  environments,
}: AppKeptVolumesProps): React.JSX.Element | null {
  const rows = environments.flatMap((e) => e.keptVolumes.map((k) => ({ env: e, ...k })));
  if (rows.length === 0) return null;
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div
          key={`${r.env.environment}/${r.resource}`}
          className="border-status-offline/30 flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3"
        >
          <HardDriveIcon className="text-muted-foreground size-4 shrink-0" />
          <p className="min-w-0 flex-1 text-sm">
            <span className="mono-data">{r.resource}</span> was removed from{' '}
            {envLabel(r.env.environment).toLowerCase()}, but its data is still on disk (
            {r.volumes.length} volume{r.volumes.length === 1 ? '' : 's'}).
          </p>
          <PurgeDataDialog
            repoId={repoId}
            environment={r.env.environment}
            stack={r.env.stack}
            resource={r.resource}
          />
        </div>
      ))}
    </div>
  );
}
