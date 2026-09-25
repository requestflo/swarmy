import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { BoxesIcon } from 'lucide-react';
import { EmptyState } from '@swarmy/ui';
import { CalmTopBar, UnderPageHeadline } from '@/components/calm';
import { useApps } from '@/components/apps/use-apps';
import { StackHeader } from './stack-header';

interface StackWorkspaceLayoutProps {
  stack: string;
  children: React.ReactNode;
}

/**
 * The app workspace (RApp): an app is the unit you operate, so everything it
 * needs lives here as a tab, each a real URL. The calm top bar (Apps / name +
 * this page's depth switch) and one `StackHeader` sit above every tab,
 * unchanged between them. Tabs render their own body only — no second top bar — and their
 * sentence steps down to a lede under the app's (one headline per page).
 */
export function StackWorkspaceLayout({ stack, children }: StackWorkspaceLayoutProps): React.JSX.Element {
  const a = useApps();
  const app = [...a.apps, ...a.platform].find((x) => x.name === stack);

  if (a.inventory && !app) return <StackNotFound stack={stack} />;

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
