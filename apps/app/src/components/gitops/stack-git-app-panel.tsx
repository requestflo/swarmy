import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { DatabaseIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { Section, StatusWord, toneFromStatus } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { AppEnvironmentsList } from './app-environments-list';
import {
  canPromote,
  findStackApp,
  previewDataNote,
  previewLabel,
  type StackAppMatch,
} from './gitops-types';
import { AppDeployButton } from './app-deploy-button';
import { AppDriftBadge } from './app-drift-badge';
import { AppKeptVolumes } from './app-kept-volumes';
import { AppNeedsYou } from './app-needs-you';
import { AppSource } from './app-source';
import { PlanDrawer } from './plan-drawer';
import { envLabel, planStatus, sha7 } from './plan-status';
import { PromoteDialog } from './promote-dialog';

/** Status / sha / latest plan / label for either kind of git-owned stack. */
function summary(m: StackAppMatch): {
  where: string;
  status?: string;
  sha?: string;
  planId?: string;
} {
  if (m.kind === 'env') {
    const l = m.env.latest;
    return { where: envLabel(m.env.environment), status: l?.status, sha: l?.sha, planId: l?.id };
  }
  const p = m.preview;
  return { where: `Preview · ${previewLabel(p)}`, status: p.status, sha: p.sha, planId: p.planId };
}

/**
 * "From Git" on a stack's Releases tab — only for stacks a swarmy.yaml owns
 * (an app environment or a preview). Everything else renders nothing.
 */
export function StackGitAppPanel({ stack }: { stack: string }): React.JSX.Element | null {
  const trpc = useTRPC();
  const apps = useQuery({ ...trpc.apps.list.queryOptions(), refetchInterval: 15_000 });
  const [open, setOpen] = React.useState<{ id: string; from?: string } | null>(null);
  const match = apps.data ? findStackApp(apps.data, stack) : null;
  if (!match) return null;

  const { app } = match;
  const env = match.kind === 'env' ? match.env : null;
  const s = summary(match);
  const dataNote = match.kind === 'preview' ? previewDataNote(match.preview) : null;
  const openPlan = (id: string, from?: string): void => setOpen({ id, from });

  return (
    <Section
      title={`From git · ${s.where}`}
      action={<AppDriftBadge repoId={app.repoId} drift={app.drift} stack={stack} />}
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <AppSource
            app={app}
            branch={env?.branch ?? (match.kind === 'preview' ? match.preview.branch : undefined)}
          />
        </div>
        {env && canPromote(env) ? (
          <PromoteDialog repoId={app.repoId} env={env} onPlan={openPlan} />
        ) : null}
        {env ? (
          <AppDeployButton
            repoId={app.repoId}
            branch={env.environment === 'production' ? undefined : env.branch}
            onPlan={openPlan}
          />
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {s.status ? (
          <StatusWord tone={toneFromStatus(planStatus(s.status).tone)} word={planStatus(s.status).label} />
        ) : (
          <span className="text-muted-foreground text-[13.5px]">Waiting for the first push</span>
        )}
        {s.sha ? <span className="text-muted-foreground font-mono text-[11.5px]">{sha7(s.sha)}</span> : null}
        {s.planId ? (
          <Button variant="ghost" size="sm" onClick={() => openPlan(s.planId as string)}>
            View plan
          </Button>
        ) : null}
      </div>
      {dataNote ? (
        <p className="text-muted-foreground flex items-start gap-2 text-sm">
          <DatabaseIcon className="text-tone-info mt-0.5 size-4 shrink-0" /> {dataNote}
        </p>
      ) : null}
      {env ? <AppNeedsYou environments={[env]} onOpen={openPlan} /> : null}
      {env ? <AppKeptVolumes repoId={app.repoId} environments={[env]} /> : null}
      <PlanDrawer
        planId={open?.id ?? null}
        configPath={app.configPath}
        promotedFrom={open?.from}
        onClose={() => setOpen(null)}
      />
      <AppEnvironmentsList app={app} stack={stack} />
    </Section>
  );
}
