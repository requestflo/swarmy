import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from '@swarmy/ui';
import type { RevealedSecret } from '@/components/secretsmgr/secret-reveal-banner';
import { useTRPC } from '@/integrations/trpc';

export type AddKind = 'plain' | 'secret' | 'ref';

export interface AddRequest {
  kind: AddKind;
  key: string;
  value: string;
  /** The live service it goes on (id + swarm name). */
  service: { id: string; name: string; short: string };
  /** Reference: the resource it points at. */
  resource?: { kind: 'postgres' | 'cache'; name: string };
}

/**
 * Add one setting the way swarmy can write it today: a plain value
 * (`services.update`, rolling), a secret (`secrets.create` + `attach`, write-only)
 * or a reference wired by the resource (`db.inject` / `cache.attachToService`).
 */
export function useAddVariable(
  stack: string,
  onSecret: (r: RevealedSecret) => void,
): { add: (r: AddRequest) => Promise<boolean>; pending: boolean } {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const update = useMutation(trpc.services.update.mutationOptions());
  const create = useMutation(trpc.secrets.create.mutationOptions());
  const attach = useMutation(trpc.secrets.attach.mutationOptions());
  const inject = useMutation(trpc.db.inject.mutationOptions());
  const cache = useMutation(trpc.cache.attachToService.mutationOptions());

  const add = async (r: AddRequest): Promise<boolean> => {
    try {
      if (r.kind === 'plain') {
        const cur = await qc.fetchQuery(trpc.services.get.queryOptions({ id: r.service.id }));
        const env = Object.entries({ ...cur.env, [r.key]: r.value }).map(([key, value]) => ({ key, value }));
        await update.mutateAsync({ id: r.service.id, env });
        toast.success(`${r.key} is set on ${r.service.short}; it restarts one copy at a time`);
      } else if (r.kind === 'secret') {
        const made = await create.mutateAsync({ family: r.key, value: r.value, stack });
        await attach.mutateAsync({ family: made.family, service: r.service.name });
        onSecret({ family: made.family, version: made.version, value: r.value });
        toast.success(`${made.family} is a secret now, mounted into ${r.service.short}`);
      } else if (r.resource) {
        const input = { stack, appService: r.service.name, cluster: r.resource.name, envVar: r.key };
        if (r.resource.kind === 'postgres') await inject.mutateAsync(input);
        else await cache.mutateAsync(input);
        toast.success(`${r.key} points at ${r.resource.name}; ${r.service.short} restarts once, rolling`);
      }
      void qc.invalidateQueries();
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    }
  };
  const pending = update.isPending || create.isPending || attach.isPending || inject.isPending || cache.isPending;
  return { add, pending };
}
