import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, StatusBadge } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { findStackApp } from './gitops-types';
import { AppDeployButton } from './app-deploy-button';
import { AppDriftBadge } from './app-drift-badge';
import { AppNeedsYou } from './app-needs-you';
import { AppSource } from './app-source';
import { PlanDrawer } from './plan-drawer';
import { envLabel, planStatus, sha7 } from './plan-status';

/**
 * "From Git" on a stack's Releases tab — only for stacks a swarmy.yaml owns
 * (an app environment or a PR preview). Everything else renders nothing.
 */
export function StackGitAppPanel({ stack }: { stack: string }): React.JSX.Element | null {
  const trpc = useTRPC();
  const apps = useQuery({ ...trpc.apps.list.queryOptions(), refetchInterval: 15_000 });
  const [planId, setPlanId] = React.useState<string | null>(null);
  const match = apps.data ? findStackApp(apps.data, stack) : null;
  if (!match) return null;

  const { app } = match;
  const env = match.kind === 'env' ? match.env : null;
  const status = env
    ? env.latest?.status
    : match.kind === 'preview'
      ? match.preview.status
      : undefined;
  const sha = env ? env.latest?.sha : match.kind === 'preview' ? match.preview.sha : undefined;
  const latestId = env
    ? env.latest?.id
    : match.kind === 'preview'
      ? match.preview.planId
      : undefined;
  const where = env
    ? envLabel(env.environment)
    : match.kind === 'preview'
      ? `Preview #${match.preview.pr}`
      : '';

  return (
    <section className="card-pop mb-6 space-y-3 p-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 font-semibold">
            From Git · {where}
            <AppDriftBadge repoId={app.repoId} drift={app.drift} stack={stack} />
          </p>
          <AppSource app={app} branch={env?.branch} />
        </div>
        {env ? (
          <AppDeployButton
            repoId={app.repoId}
            branch={env.environment === 'production' ? undefined : env.branch}
            onPlan={setPlanId}
          />
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {status ? (
          <StatusBadge {...planStatus(status)} />
        ) : (
          <span className="text-muted-foreground text-sm">Waiting for the first push</span>
        )}
        {sha ? <span className="text-muted-foreground mono-label">{sha7(sha)}</span> : null}
        {latestId ? (
          <Button variant="ghost" size="sm" onClick={() => setPlanId(latestId)}>
            View plan
          </Button>
        ) : null}
      </div>
      {env ? <AppNeedsYou environments={[env]} onOpen={setPlanId} /> : null}
      <PlanDrawer planId={planId} configPath={app.configPath} onClose={() => setPlanId(null)} />
    </section>
  );
}
