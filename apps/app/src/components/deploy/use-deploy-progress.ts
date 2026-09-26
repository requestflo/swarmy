import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { BlueprintDeployResultView } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { deriveDeploy, type DeployDomain, type DeployProgress, type StepKey } from './deploy-steps';

export interface DeployWatch extends DeployProgress {
  /** Inventory + routes have landed at least once (until then: skeleton). */
  ready: boolean;
  /** Seconds after the deploy went out that each step was first seen done (this tab only). */
  doneAt: Partial<Record<StepKey, number>>;
  /** The server its main service runs on, when swarmy knows it. */
  server: string | null;
  stackId: string | null;
}

/**
 * Watch a fresh deploy: the live inventory and the app's routes, polled every
 * 2 s while it is deploying and not at all once it is live. Step times are
 * what this tab saw — never invented — so a step already done on arrival
 * shows "done" without a time.
 */
export function useDeployProgress(stack: string, result: BlueprintDeployResultView | null, startedAt: number | null): DeployWatch {
  const trpc = useTRPC();
  const [live, setLive] = React.useState(false);
  const every = live ? false : 2_000;
  const inv = useQuery({ ...trpc.inventory.get.queryOptions(), refetchInterval: every });
  const doms = useQuery({ ...trpc.ingress.listDomains.queryOptions({ stack }), refetchInterval: every });
  const svcs = useQuery({ ...trpc.services.list.queryOptions({ stackId: stack }), refetchInterval: live ? false : 5_000 });
  const nodes = useQuery(trpc.nodes.list.queryOptions());
  const stacks = useQuery(trpc.stacks.list.queryOptions());

  const progress = React.useMemo(
    () =>
      deriveDeploy({
        stack,
        result,
        services: (inv.data?.services ?? []).filter((s) => s.stack === stack),
        domains: (doms.data ?? []) as DeployDomain[],
      }),
    [stack, result, inv.data, doms.data],
  );

  React.useEffect(() => setLive(progress.live), [progress.live]);

  const times = React.useRef<Partial<Record<StepKey, number>>>({});
  const seen = React.useRef(false);
  const ready = Boolean(inv.data) && !doms.isPending;
  if (ready) {
    for (const s of progress.steps) {
      if (s.state !== 'done' || s.key in times.current) continue;
      // Done on the first look = done before we watched: no time to claim.
      times.current[s.key] = seen.current && startedAt ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : -1;
    }
    seen.current = true;
  }
  const doneAt = Object.fromEntries(Object.entries(times.current).filter(([, v]) => v >= 0)) as DeployWatch['doneAt'];

  const nodeId = svcs.data?.find((s) => progress.primary && (s.id === progress.primary.id || s.name === progress.primary.name))?.nodeId ?? null;
  const list = nodes.data ?? [];
  const node = list.find((n) => n.id === nodeId) ?? (list.length === 1 ? list[0] : undefined);

  return {
    ...progress,
    ready,
    doneAt,
    server: node?.name ?? null,
    stackId: stacks.data?.find((s) => s.name === stack)?.id ?? null,
  };
}
