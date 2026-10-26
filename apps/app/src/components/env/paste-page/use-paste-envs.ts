import { useQueries, useQuery } from '@tanstack/react-query';
import { shortName } from '@/components/app-tabs/use-stack-services';
import { useEnvTabs } from '@/components/app-tabs/variables/use-env-tabs';
import { useTRPC } from '@/integrations/trpc';
import type { PasteEnvSide } from './paste-target';

export interface PasteEnvs {
  /** Each environment that runs this service, with its live env and what swarmy.yaml declares there. */
  sides: PasteEnvSide[] | undefined;
  /** The environment this page's stack is. */
  here: string;
  /** A git app with environments to pick from; false = one stack. */
  gitApp: boolean;
  /** Why nothing is locked although swarmy.yaml owns the stack. */
  lockNote: string | null;
  /** swarmy.yaml couldn't be read, so which rows are locked is unknown: nothing may be applied. */
  blocked: boolean;
}

/**
 * The paste page's targets (board 58): for a git app, the service's copy in
 * every environment's own stack (live env from `services.get`) with the
 * variables swarmy.yaml declares for it there (`apps.declaredEnv`); for any
 * other stack, just this one. A preview is one stack that reads production's
 * layers.
 */
export function usePasteEnvs(stack: string, short: string): PasteEnvs {
  const trpc = useTRPC();
  const { match } = useEnvTabs(stack);
  const owned = match !== null && match !== undefined;
  const declared = useQuery({ ...trpc.apps.declaredEnv.queryOptions({ stack }), enabled: owned, staleTime: 60_000 });
  const inventory = useQuery({ ...trpc.inventory.get.queryOptions(), refetchInterval: 4_000 });
  const here = match?.kind === 'env' ? match.env.environment : match?.kind === 'preview' ? 'preview' : stack;
  const envs = match?.kind === 'env' ? match.app.environments.map((e) => ({ environment: e.environment, stack: e.stack })) : [{ environment: here, stack }];
  const ids = envs.map(
    (e) => inventory.data?.services.find((s) => s.stack === e.stack && !s.regionParent && shortName(e.stack, s.name) === short)?.id ?? null,
  );
  const details = useQueries({ queries: ids.map((id) => ({ ...trpc.services.get.queryOptions({ id: id ?? '' }), enabled: !!id })) });

  const ready = !!short && match !== undefined && !!inventory.data && (!owned || !declared.isPending) && details.every((d, k) => !ids[k] || d.data);
  const lockedFor = (env: string): Record<string, string> => {
    const e = declared.data?.environments.find((x) => x.environment === (env === 'preview' ? 'production' : env));
    return e?.services[short] ?? {};
  };
  const sides = ready
    ? envs.flatMap((e, k) => {
        const id = ids[k];
        const d = details[k]?.data;
        return id && d ? [{ environment: e.environment, stack: e.stack, serviceId: id, current: d.env ?? {}, declared: lockedFor(e.environment) }] : [];
      })
    : undefined;
  const blocked = owned && declared.isError;
  const lockNote = blocked
    ? `swarmy.yaml couldn’t be read (${declared.error.message}), so swarmy can’t tell which variables it declares`
    : owned
      ? (declared.data?.reason ?? null)
      : null;
  return { sides, here, gitApp: match?.kind === 'env', lockNote, blocked };
}
