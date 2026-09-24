import * as React from 'react';
import { canPromote, type GitApp } from './gitops-types';
import { AppDeployButton } from './app-deploy-button';
import { AppDriftBadge } from './app-drift-badge';
import { AppEnvChip } from './app-env-chip';
import { AppKeptVolumes } from './app-kept-volumes';
import { AppNeedsYou } from './app-needs-you';
import { AppPreviewDataNotes } from './app-preview-data-notes';
import { AppPreviewsChip } from './app-previews-chip';
import { AppSource } from './app-source';
import { AppSwitches } from './app-switches';
import { PromoteDialog } from './promote-dialog';

interface AppRowProps {
  app: GitApp;
  /** Open a plan; `promotedFrom` when it came from a promote. */
  onOpenPlan: (planId: string, configPath: string, promotedFrom?: string) => void;
}

/** One app from Git: its source, the environment strip (production · staging · previews), and its knobs. */
export function AppRow({ app, onOpenPlan }: AppRowProps): React.JSX.Element {
  const open = (planId: string, from?: string): void => onOpenPlan(planId, app.configPath, from);
  return (
    <div className="space-y-3 px-6 py-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 font-semibold">
            {app.appName ?? app.fullName ?? app.url}
            <AppDriftBadge repoId={app.repoId} drift={app.drift} />
          </p>
          <AppSource app={app} />
        </div>
        <AppDeployButton repoId={app.repoId} onPlan={open} />
      </div>
      <AppSwitches app={app} />
      <AppNeedsYou environments={app.environments} onOpen={open} />
      <div className="flex flex-wrap gap-2">
        {app.environments.map((e) => (
          <div key={e.environment} className="flex min-w-44 flex-1 flex-col gap-2">
            <AppEnvChip env={e} onOpen={open} />
            {canPromote(e) ? <PromoteDialog repoId={app.repoId} env={e} onPlan={open} /> : null}
          </div>
        ))}
        <AppPreviewsChip previews={app.previews} onOpen={open} />
      </div>
      <AppPreviewDataNotes previews={app.previews} />
      <AppKeptVolumes repoId={app.repoId} environments={app.environments} />
    </div>
  );
}
