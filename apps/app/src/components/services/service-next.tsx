import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ServiceDetail } from '@swarmy/core';
import { Button, toast } from '@swarmy/ui';
import { NextAction } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';

/** A service short of copies or down: restart it (the page's coral action). */
export function ServiceNext({ service }: { service: ServiceDetail }): React.JSX.Element | null {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const restart = useMutation(
    trpc.services.restart.mutationOptions({
      onSuccess: () => {
        toast.success(`Restarting ${service.name}, one copy at a time`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const { running, desired } = service.replicas;
  if (!(service.status === 'degraded' || service.status === 'failed') || desired === 0) return null;
  return (
    <NextAction
      className="mt-5"
      tone={running === 0 ? 'bad' : 'warn'}
      title={running === 0 ? `No copy of ${service.name} is running` : `${desired - running} of ${desired} copies of ${service.name} won't start`}
      tech={service.lastError ?? `${service.swarmServiceId ?? service.id} · ${running}/${desired} running`}
      actions={
        <Button disabled={restart.isPending} onClick={() => restart.mutate({ id: service.id })}>
          {restart.isPending ? 'Restarting…' : `Restart ${service.name}`}
        </Button>
      }
    >
      A restart starts fresh copies one at a time. If they keep failing, the logs below say why.
    </NextAction>
  );
}
