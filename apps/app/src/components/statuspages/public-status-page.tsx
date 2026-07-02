import * as React from 'react';
import type { PublicComponentView } from '@swarmy/core';
import { Skeleton, StatusBadge, cn } from '@swarmy/ui';
import { usePublicStatus } from './use-public-status';
import { PublicIncidents } from './public-incidents';
import { UptimeBars } from './uptime-bars';
import {
  OVERALL_CLASSES,
  OVERALL_LABEL,
  PUBLIC_STATUS_LABEL,
  PUBLIC_STATUS_TONE,
} from './status-tone';

function ComponentRow({ component }: { component: PublicComponentView }): React.JSX.Element {
  return (
    <div className="border-border border-b px-5 py-4 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">{component.label}</p>
        <StatusBadge
          tone={PUBLIC_STATUS_TONE[component.status]}
          label={PUBLIC_STATUS_LABEL[component.status]}
        />
      </div>
      {component.uptime90d.length > 0 ? (
        <>
          <UptimeBars days={component.uptime90d} className="mt-3" />
          <div className="text-muted-foreground mt-1.5 flex justify-between text-xs">
            <span>90 days ago</span>
            <span className="mono-data">
              {component.uptimePct === null ? 'no data yet' : `${component.uptimePct}% uptime`}
            </span>
            <span>today</span>
          </div>
        </>
      ) : null}
    </div>
  );
}

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
          <>
            <header className="mb-6">
              <h1 className="headline text-[2.2rem] sm:text-5xl">{snapshot.data.page.title}</h1>
              <p className="text-muted-foreground mt-2 text-sm">
                Live status · updated{' '}
                <span className="mono-data">
                  {new Date(snapshot.data.generatedAt).toLocaleTimeString()}
                </span>
              </p>
            </header>

            <div
              className={cn(
                'mb-8 flex items-center gap-3 rounded-2xl px-5 py-4 text-base font-bold sm:text-lg',
                OVERALL_CLASSES[snapshot.data.overall],
              )}
            >
              <span className="size-2.5 shrink-0 rounded-full bg-current" />
              {OVERALL_LABEL[snapshot.data.overall]}
            </div>

            {snapshot.data.components.length > 0 ? (
              <section className="mb-10">
                <h2 className="mono-label text-muted-foreground mb-3">Components</h2>
                <div className="card-pop overflow-hidden p-0">
                  {snapshot.data.components.map((component) => (
                    <ComponentRow key={component.key} component={component} />
                  ))}
                </div>
              </section>
            ) : null}

            <section>
              <h2 className="mono-label text-muted-foreground mb-3">Incident history</h2>
              <PublicIncidents incidents={snapshot.data.incidents} />
            </section>
          </>
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
