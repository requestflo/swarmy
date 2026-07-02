import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CacheClusterView } from '@swarmy/core';
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

const MEMORY_CHOICES = [128, 256, 512, 1024, 2048, 4096];
const fmtMb = (m: number): string => (m >= 1024 ? `${m / 1024} GB` : `${m} MB`);

/** Replica-count + maxmemory tuners (label writes; the reconcile converges). */
export function CacheTuningControls({ view }: { view: CacheClusterView }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const minReplicas = view.topology === 'sentinel' ? 1 : 0;

  const setReplicas = useMutation(
    trpc.cache.setReplicas.mutationOptions({
      onSuccess: (r) => {
        toast.success(`Replicas → ${r.replicas}`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const setMemory = useMutation(
    trpc.cache.setMemory.mutationOptions({
      onSuccess: (r) => {
        toast.success(`Memory → ${fmtMb(r.memoryMb)} (members redeploy)`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const pending = setReplicas.isPending || setMemory.isPending;
  const ref = { stack: view.stack, cluster: view.name };

  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="grid gap-1.5">
        <span className="mono-label text-muted-foreground">Replicas</span>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            disabled={pending || view.topology === 'single' || view.declaredReplicas <= minReplicas}
            onClick={() => setReplicas.mutate({ ...ref, replicas: view.declaredReplicas - 1 })}
          >
            −
          </Button>
          <span className="mono-data w-8 text-center text-sm">{view.declaredReplicas}</span>
          <Button
            size="sm"
            variant="outline"
            disabled={pending || view.topology === 'single' || view.declaredReplicas >= 10}
            onClick={() => setReplicas.mutate({ ...ref, replicas: view.declaredReplicas + 1 })}
          >
            +
          </Button>
        </div>
        {view.topology === 'single' ? (
          <p className="text-muted-foreground text-[11px]">Single mode has no replicas.</p>
        ) : null}
      </div>
      <div className="grid gap-1.5">
        <span className="mono-label text-muted-foreground">Max memory</span>
        <Select
          value={String(view.memoryMb)}
          disabled={pending}
          onValueChange={(v) => setMemory.mutate({ ...ref, memoryMb: Number(v) })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[...new Set([...MEMORY_CHOICES, view.memoryMb])]
              .sort((a, b) => a - b)
              .map((m) => (
                <SelectItem key={m} value={String(m)}>
                  {fmtMb(m)}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
