import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from '@swarmy/ui';
import { useTRPCClient } from '@/integrations/trpc';
import type { DataNodeSpec } from '../data-nodes';
import { storeWords } from './connect-plan';

/** The part being connected: its inventory id and swarm name. */
export interface ConnectFrom {
  id: string;
  name: string;
  short: string;
}

/**
 * Connect a part to a store with that store's own attach call (`db.inject`,
 * `cache` / `search` / `vector.attachToService`, `buckets.attachToService`),
 * then a toast; Undo runs the matching detach where one exists (Postgres has
 * none). Managed stores take the part's swarm name; a bucket its id.
 */
export function useConnect(stack: string): { connect: (from: ConnectFrom, to: DataNodeSpec) => Promise<boolean>; pending: boolean } {
  const client = useTRPCClient();
  const qc = useQueryClient();
  const refresh = React.useCallback(() => void qc.invalidateQueries(), [qc]);

  const m = useMutation({
    mutationFn: async ({ from, to }: { from: ConnectFrom; to: DataNodeSpec }): Promise<(() => Promise<unknown>) | null> => {
      const appService = from.name.startsWith(`${stack}_`) ? from.name : `${stack}_${from.name}`;
      switch (to.kind) {
        case 'postgres':
          await client.db.inject.mutate({ stack, cluster: to.name, appService });
          return null;
        case 'cache':
          await client.cache.attachToService.mutate({ stack, cluster: to.name, appService });
          return () => client.cache.detach.mutate({ stack, cluster: to.name, appService });
        case 'search':
          await client.search.attachToService.mutate({ stack, name: to.name, appService });
          return () => client.search.detach.mutate({ stack, name: to.name, appService });
        case 'vector':
          await client.vector.attachToService.mutate({ stack, name: to.name, appService });
          return () => client.vector.detach.mutate({ stack, name: to.name, appService });
        case 'object-storage': {
          if (!to.bucketId) throw new Error(`Can't find the bucket ${to.name}.`);
          const r = await client.buckets.attachToService.mutate({ bucketId: to.bucketId, appService: from.id });
          return () => client.buckets.detach.mutate({ appService: r.appService });
        }
      }
    },
  });

  const connect = React.useCallback(
    async (from: ConnectFrom, to: DataNodeSpec): Promise<boolean> => {
      const what = storeWords(to);
      try {
        const undo = await m.mutateAsync({ from, to });
        const say = `${from.short} now uses ${what} · ${to.env.length} variables added, it restarts to pick them up`;
        const action = undo
          ? {
              label: 'Undo',
              onClick: () =>
                void undo()
                  .then(() => toast.success(`${from.short} no longer uses ${what} · its variables are gone`))
                  .catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e)))
                  .finally(refresh),
            }
          : undefined;
        toast.success(say, action ? { action, duration: 12_000 } : undefined);
        return true;
      } catch (e) {
        toast.error(`Couldn't connect ${from.short} to ${what}. ${e instanceof Error ? e.message : String(e)}`);
        return false;
      } finally {
        refresh();
      }
    },
    [m, refresh],
  );

  return { connect, pending: m.isPending };
}
