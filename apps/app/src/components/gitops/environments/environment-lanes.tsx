import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Section } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { canPromote, findStackApp } from '../gitops-types';
import { CloneEnvSheet } from './clone-env-sheet';
import { DashboardEnvNote } from './dashboard-env-note';
import { EnvLane } from './env-lane';
import { LaneDomains } from './lane-domains';
import { laneDomains, laneHosts } from './lane-domains-model';
import { imagesOf, laneServices } from './lanes-model';
import { PromoteSheet } from './promote-sheet';

/**
 * Environments side by side (board Environments): the same app, one stack
 * per branch — each lane's addresses (with Add a domain), its live services
 * and the image each runs, blue where production differs, Promote →
 * production on the ones that can, and
 * Clone as a new environment from the one this page is. For every environment
 * of a swarmy.yaml app (never a preview) — with only production, it's the way to a second.
 */
export function EnvironmentLanes({ stack }: { stack: string }): React.JSX.Element | null {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const apps = useQuery({ ...trpc.apps.list.queryOptions(), refetchInterval: 15_000 });
  const inventory = useQuery({ ...trpc.inventory.get.queryOptions(), refetchInterval: 4_000 });
  const routed = useQuery({ ...trpc.ingress.listDomains.queryOptions(), refetchInterval: 15_000 });
  const match = apps.data ? findStackApp(apps.data, stack) : null;
  if (!match || match.kind !== 'env') return null;
  const { app } = match;
  const envs = [...app.environments].sort((a, b) => (a.environment === 'production' ? -1 : b.environment === 'production' ? 1 : 0));
  const prod = envs.find((e) => e.environment === 'production');
  const live = inventory.data?.services;
  const prodImages = live && prod ? imagesOf(prod.stack, live) : new Map<string, string>();
  const drift = (env: string): number => app.drift?.environments.find((d) => d.environment === env)?.changes ?? 0;
  const domainsOf = (s: string) => (routed.data ? laneDomains(s, routed.data) : undefined);

  return (
    <Section
      title="Environments"
      count={envs.length}
      hint="the same app, one stack per branch · environments: in swarmy.yaml"
      action={<CloneEnvSheet app={app} from={match.env} />}
    >
      <div className={envs.length > 2 ? 'grid gap-3 lg:grid-cols-3' : 'grid gap-3 lg:grid-cols-2'}>
        {envs.length === 1 ? (
          <p className="text-muted-foreground self-center text-[13.5px] lg:order-last">
            Only production so far. Clone it as a new environment to run a branch beside it, with its own database and secrets.
          </p>
        ) : null}
        {envs.map((e) => (
          <EnvLane
            key={e.stack}
            env={e}
            here={e.stack === stack}
            drift={drift(e.environment)}
            services={live ? laneServices(e.stack, live, e === prod ? null : prodImages) : undefined}
            action={canPromote(e) ? <PromoteSheet repoId={app.repoId} env={e} prodImages={prodImages} /> : null}
            domains={<LaneDomains stack={e.stack} domains={domainsOf(e.stack)} />}
            note={
              e.dashboard ? (
                <DashboardEnvNote
                  env={e}
                  hosts={routed.data ? laneHosts(domainsOf(e.stack) ?? []) : undefined}
                  // Removing the environment this page is: go to production's.
                  onRemoved={() => {
                    if (e.stack === stack && prod) void navigate({ to: '/stacks/$name/releases', params: { name: prod.stack } });
                  }}
                />
              ) : null
            }
          />
        ))}
      </div>
      <p className="text-muted-foreground text-xs">
        A promote deploys the digests an environment runs; its variables and secrets stay its own.
      </p>
    </Section>
  );
}
