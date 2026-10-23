import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Section } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { canPromote, findStackApp } from '../gitops-types';
import { EnvLane } from './env-lane';
import { imagesOf, laneServices } from './lanes-model';
import { PromoteSheet } from './promote-sheet';

/**
 * Environments side by side (board Environments): the same app, one stack
 * per branch — each lane's live services and the image each runs, blue
 * where production differs, and Promote → production on the ones that can.
 * Only for a git app with more than one environment.
 */
export function EnvironmentLanes({ stack }: { stack: string }): React.JSX.Element | null {
  const trpc = useTRPC();
  const apps = useQuery({ ...trpc.apps.list.queryOptions(), refetchInterval: 15_000 });
  const inventory = useQuery({ ...trpc.inventory.get.queryOptions(), refetchInterval: 4_000 });
  const match = apps.data ? findStackApp(apps.data, stack) : null;
  if (!match || match.app.environments.length < 2) return null;
  const { app } = match;
  const envs = [...app.environments].sort((a, b) => (a.environment === 'production' ? -1 : b.environment === 'production' ? 1 : 0));
  const prod = envs.find((e) => e.environment === 'production');
  const live = inventory.data?.services;
  const prodImages = live && prod ? imagesOf(prod.stack, live) : new Map<string, string>();
  const drift = (env: string): number => app.drift?.environments.find((d) => d.environment === env)?.changes ?? 0;

  return (
    <Section title="Environments" count={envs.length} hint="the same app, one stack per branch · environments: in swarmy.yaml">
      <div className={envs.length > 2 ? 'grid gap-3 lg:grid-cols-3' : 'grid gap-3 lg:grid-cols-2'}>
        {envs.map((e) => (
          <EnvLane
            key={e.stack}
            env={e}
            here={e.stack === stack}
            drift={drift(e.environment)}
            services={live ? laneServices(e.stack, live, e === prod ? null : prodImages) : undefined}
            action={canPromote(e) ? <PromoteSheet repoId={app.repoId} env={e} prodImages={prodImages} /> : null}
          />
        ))}
      </div>
      <p className="text-muted-foreground text-xs">
        A promote deploys the digests an environment runs; its variables and secrets stay its own.
      </p>
    </Section>
  );
}
