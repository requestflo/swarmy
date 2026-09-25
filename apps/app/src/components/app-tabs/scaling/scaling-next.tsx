import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, toast } from '@swarmy/ui';
import { NextAction } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { shortName } from '../use-stack-services';
import type { PlacedService } from './use-app-placement';

/** A service short of copies (restart it), else a public service with a single copy (add one). */
export function ScalingNext({ stack, rows }: { stack: string; rows: PlacedService[] }): React.JSX.Element | null {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const done = { onSuccess: () => void qc.invalidateQueries(), onError: (e: { message: string }) => toast.error(e.message) };
  const restart = useMutation(trpc.services.restart.mutationOptions(done));
  const scale = useMutation(trpc.services.scale.mutationOptions(done));

  const short = rows.find((r) => r.inv.replicas.desired > 0 && r.inv.replicas.running < r.inv.replicas.desired);
  if (short) {
    const name = shortName(stack, short.inv.name);
    const { running, desired } = short.inv.replicas;
    return (
      <NextAction
        title={`${name} is running ${running} of ${desired} copies`}
        tech={short.detail?.lastError ?? `${short.inv.name} · ${short.inv.status}`}
        actions={
          <Button disabled={restart.isPending} onClick={() => restart.mutate({ id: short.inv.id })}>
            {restart.isPending ? 'Restarting…' : `Restart ${name}`}
          </Button>
        }
      >
        A restart starts fresh copies one at a time; the ones already up keep serving.
      </NextAction>
    );
  }
  const lonely = rows.find((r) => r.inv.replicas.desired === 1 && r.inv.ports.length > 0);
  if (lonely) {
    const name = shortName(stack, lonely.inv.name);
    return (
      <NextAction
        title={`${name} has one copy, so if its server stops, ${name} stops`}
        tech={`services.scale ${lonely.inv.name} → 2`}
        actions={
          <Button disabled={scale.isPending} onClick={() => scale.mutate({ id: lonely.inv.id, replicas: 2 })}>
            Add a second copy
          </Button>
        }
      >
        swarmy puts the second copy on a different server.
      </NextAction>
    );
  }
  return null;
}
