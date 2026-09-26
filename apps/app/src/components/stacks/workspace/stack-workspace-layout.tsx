import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { BoxesIcon } from 'lucide-react';
import { EmptyState } from '@swarmy/ui';
import { CalmTopBar, UnderPageHeadline } from '@/components/calm';
import { useApps, type AppItem } from '@/components/apps/use-apps';
import { DeployFlow } from '@/components/deploy/deploy-flow';
import { deployHandoff, isDeployDismissed } from '@/components/deploy/deploy-handoff';
import { PageSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { StackHeader } from './stack-header';

interface StackWorkspaceLayoutProps {
  stack: string;
  /** `?deployed=1`: a deploy just went out from this page's Deploy button. */
  deployed?: boolean;
  children: React.ReactNode;
}

/** Listed as an app but nothing has started yet: every part still waiting for its first copy. */
function notStarted(app: AppItem | undefined): boolean {
  if (!app) return true;
  const svcs = app.stat.services;
  return svcs.length > 0 && svcs.every((s) => s.status === 'deploying' && s.replicas.running === 0);
}

/**
 * The app workspace (RApp): an app is the unit you operate, so everything it
 * needs lives here as a tab, each a real URL. The calm top bar (Apps / name +
 * this page's depth switch) and one `StackHeader` sit above every tab,
 * unchanged between them. Tabs render their own body only — no second top bar — and their
 * sentence steps down to a lede under the app's (one headline per page).
 */
export function StackWorkspaceLayout({ stack, deployed, children }: StackWorkspaceLayoutProps): React.JSX.Element {
  const trpc = useTRPC();
  const a = useApps();
  const stacks = useQuery({ ...trpc.stacks.list.queryOptions(), refetchInterval: 5_000 });
  const app = [...a.apps, ...a.platform].find((x) => x.name === stack);
  const listed = stacks.data?.some((s) => s.name === stack) ?? false;
  // An old `?deployed=1` link to an app that no longer exists falls through to "not found".
  const stale = !deployHandoff(stack) && !stacks.isPending && Boolean(a.inventory) && !listed && !app;

  // A brand-new app isn't in the inventory yet: show it deploying, never "No app called …".
  if (!isDeployDismissed(stack) && !stale && (deployed || (a.inventory && listed && notStarted(app)))) {
    return <DeployFlow stack={stack} pinned={Boolean(deployed)} />;
  }
  if (a.inventory && !app) {
    if (stacks.isPending) return <PageSkeleton />;
    return <StackNotFound stack={stack} />;
  }

  return (
    <div className="flex min-h-full flex-col">
      <CalmTopBar crumbs={[{ label: 'Apps', to: '/' }, { label: stack }]} />
      <div className="mx-auto flex w-full max-w-[1600px] flex-col px-6 pt-7 pb-28 lg:pb-16 xl:px-8">
        <StackHeader stack={stack} app={app} />
        <div className="min-h-0 flex-1 pt-6">
          <UnderPageHeadline>{children}</UnderPageHeadline>
        </div>
      </div>
    </div>
  );
}

function StackNotFound({ stack }: { stack: string }): React.JSX.Element {
  return (
    <div className="flex min-h-full flex-col">
      <CalmTopBar crumbs={[{ label: 'Apps', to: '/' }, { label: stack }]} />
      <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 xl:px-8">
        <EmptyState
          icon={<BoxesIcon />}
          title={`No app called “${stack}”.`}
          description="It may have been removed, or it hasn't started yet. Your other apps are one click away."
          action={
            <Link to="/" className="text-primary font-semibold">
              ← All apps
            </Link>
          }
        />
      </div>
    </div>
  );
}
