import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MinusIcon, PlusIcon } from 'lucide-react';
import { Button, CopyButton, toast } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { CacheAttachSection } from './cache-attach-section';
import { CacheBackupsSection } from './cache-backups-section';
import { DestroyCacheDialog } from './destroy-cache-dialog';
import type { CacheView } from './cache-words';

/** Standby copies − n + (`cache.setReplicas`); a sentinel cache keeps at least one. */
function ReplicaStepper({ v }: { v: CacheView }): React.JSX.Element | null {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const set = useMutation(
    trpc.cache.setReplicas.mutationOptions({
      onSuccess: (r) => {
        toast.success(`${v.name} → ${r.replicas} standby ${r.replicas === 1 ? 'copy' : 'copies'}`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  if (v.topology === 'single') return null;
  const min = v.topology === 'sentinel' ? 1 : 0;
  const n = v.declaredReplicas;
  const go = (to: number): void => set.mutate({ stack: v.stack, cluster: v.name, replicas: to });
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-[13.5px] font-semibold">Standby copies</span>
      <Button variant="outline" size="icon" aria-label="Remove a standby copy" className="size-9 pointer-coarse:size-11" disabled={set.isPending || n <= min} onClick={() => go(n - 1)}>
        <MinusIcon className="size-4" />
      </Button>
      <span className="font-mono tabular-nums">
        {v.replicas.running}
        <span className="text-muted-foreground"> / {n}</span>
      </span>
      <Button variant="outline" size="icon" aria-label="Add a standby copy" className="size-9 pointer-coarse:size-11" disabled={set.isPending || n >= 10} onClick={() => go(n + 1)}>
        <PlusIcon className="size-4" />
      </Button>
      <span className="text-muted-foreground text-xs">running / wanted</span>
    </div>
  );
}

/**
 * A cache's Controls: standby copies, the address and password secret, the
 * apps wired to it, its saves and removing it (the existing pieces).
 */
export function CacheBlockControls({ v }: { v: CacheView }): React.JSX.Element {
  const url = `redis://${v.host}:${v.port}`;
  return (
    <div className="border-border flex flex-col gap-5 border-t pt-4">
      <ReplicaStepper v={v} />
      <div className="flex flex-col gap-1">
        <div className="bg-muted/40 flex items-center justify-between gap-2 rounded-md px-3 py-1.5">
          <code className="truncate font-mono text-xs">{url}</code>
          <CopyButton value={url} aria-label="Copy the cache address" className="size-9" />
        </div>
        <Tech>private network only · password in the Docker secret {v.passwordSecret}, shown once at create</Tech>
      </div>
      <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <CacheAttachSection view={v} />
        <CacheBackupsSection view={v} />
      </div>
      <DestroyCacheDialog view={v} onDestroyed={() => undefined} />
    </div>
  );
}
