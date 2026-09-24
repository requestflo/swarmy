import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheckIcon } from 'lucide-react';
import { useTRPC } from '@/integrations/trpc';
import { CardSkeleton, EmptyState, ErrorState } from '@/components/states';
import { RequireLoginCard } from './require-login-card';
import { WhoCanEnterCard } from './who-can-enter-card';
import { EndUsersCard } from './end-users-card';
import type { AppAccessViewData } from './types';

/** The app Access tab: Require login, who can enter, and (with `auth:`) the app's own users. */
export function AppAccessSection({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const q = useQuery({ ...trpc.appAccess.get.queryOptions({ stack }), refetchInterval: 10_000 });

  if (q.isPending) {
    return (
      <div className="space-y-4">
        <CardSkeleton lines={3} />
        <CardSkeleton lines={4} />
      </div>
    );
  }
  if (q.isError) return <ErrorState error={q.error} retry={() => void q.refetch()} retrying={q.isFetching} />;
  const view: AppAccessViewData = q.data;
  const appRoutes = view.routes.filter((r) => !r.endUserAuth);

  return (
    <div className="space-y-10">
      {appRoutes.length === 0 ? (
        <div className="card-pop p-2">
          <EmptyState
            icon={<ShieldCheckIcon />}
            title="Give this app a domain first"
            description="Login protection runs at swarmy's edge, on the app's domains. Add one on the Network tab, then come back to turn on Require login."
          />
        </div>
      ) : (
        <>
          <RequireLoginCard stack={stack} routes={appRoutes} />
          <WhoCanEnterCard stack={stack} view={view} />
        </>
      )}
      {view.endUserAuth ? <EndUsersCard stack={stack} auth={view.endUserAuth} /> : null}
    </div>
  );
}
