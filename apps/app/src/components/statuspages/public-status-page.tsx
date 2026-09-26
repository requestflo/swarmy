import * as React from 'react';
import { Skeleton } from '@swarmy/ui';
import { usePublicStatus } from './use-public-status';
import { PublicStatusBody } from './public-status-body';

function LoadingSkeleton(): React.JSX.Element {
  return (
    <div className="grid gap-4">
      <Skeleton className="h-16 w-full rounded-2xl" />
      <Skeleton className="h-24 w-full rounded-2xl" />
      <Skeleton className="h-24 w-full rounded-2xl" />
    </div>
  );
}

/**
 * The public status page body — clean, brandable, mobile-fine. No shell, no
 * auth: page title, overall banner, component rows with 90-day uptime bars,
 * incident history, "powered by swarmy" footer.
 */
export function PublicStatusPage({ slug }: { slug: string }): React.JSX.Element {
  const snapshot = usePublicStatus(slug);

  return (
    <main className="bg-background text-foreground min-h-screen">
      <div className="mx-auto w-full max-w-3xl px-6 py-14 sm:py-20">
        {snapshot.isLoading ? (
          <LoadingSkeleton />
        ) : snapshot.isError || !snapshot.data ? (
          <div className="py-16 text-center">
            <h1 className="headline text-[2rem] sm:text-4xl">
              Nothing to <em>see</em> here.
            </h1>
            <p className="text-muted-foreground mt-3 text-sm sm:text-base">
              {snapshot.error?.message === 'not-found'
                ? 'This status page doesn’t exist — check the address.'
                : (snapshot.error?.message ?? 'Something went wrong loading this page.')}
            </p>
          </div>
        ) : (
          <PublicStatusBody snapshot={snapshot.data} />
        )}

        <footer className="text-muted-foreground mt-14 flex items-center justify-center gap-1 text-xs">
          powered by
          <span className="font-display font-bold">
            swarm<span className="text-primary">y</span>
          </span>
        </footer>
      </div>
    </main>
  );
}
