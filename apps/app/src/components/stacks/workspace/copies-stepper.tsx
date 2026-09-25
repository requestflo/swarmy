import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MinusIcon, PlusIcon } from 'lucide-react';
import type { InvService } from '@swarmy/core';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/** Copies − n + for one part, applied with the existing `services.scale` call. */
export function CopiesStepper({ service }: { service: InvService }): React.JSX.Element | null {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [want, setWant] = React.useState(service.replicas.desired);
  React.useEffect(() => setWant(service.replicas.desired), [service.id, service.replicas.desired]);
  const scale = useMutation(
    trpc.services.scale.mutationOptions({
      onSuccess: (_d, v) => {
        toast.success(`${service.name}: ${v.replicas} ${v.replicas === 1 ? 'copy' : 'copies'}`);
        void qc.invalidateQueries();
      },
      onError: (e) => {
        toast.error(e.message);
        setWant(service.replicas.desired);
      },
    }),
  );
  if (service.mode === 'global') return null;
  const set = (n: number): void => {
    const next = Math.max(0, Math.min(50, n));
    setWant(next);
    scale.mutate({ id: service.id, replicas: next });
  };
  return (
    <div className="flex flex-col gap-1">
      <span id={`copies-${service.id}`} className="text-muted-foreground text-[11.5px]">
        Copies
      </span>
      <div role="group" aria-labelledby={`copies-${service.id}`} className="border-border flex items-center rounded-lg border">
        <Button variant="ghost" size="icon" className="size-8 pointer-coarse:size-11" aria-label="One fewer copy" disabled={scale.isPending || want <= 0} onClick={() => set(want - 1)}>
          <MinusIcon className="size-4" />
        </Button>
        <output aria-live="polite" className="w-8 text-center font-mono text-sm">
          {want}
        </output>
        <Button variant="ghost" size="icon" className="size-8 pointer-coarse:size-11" aria-label="One more copy" disabled={scale.isPending} onClick={() => set(want + 1)}>
          <PlusIcon className="size-4" />
        </Button>
      </div>
    </div>
  );
}
