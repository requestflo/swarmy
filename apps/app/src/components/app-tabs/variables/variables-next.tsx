import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { SecretFamilyView } from '@swarmy/core';
import { Button, toast } from '@swarmy/ui';
import { NextAction } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { relTime } from '@/lib/format';
import type { VarRow } from './variables-model';

/**
 * The one thing worth doing on Variables & secrets, if anything: a service
 * still reading an old secret, else a password kept as a plain variable.
 */
export function VariablesNext({
  families,
  rows,
  onAddSecret,
}: {
  families: SecretFamilyView[];
  rows: VarRow[];
  onAddSecret: () => void;
}): React.JSX.Element | null {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const move = useMutation(
    trpc.secrets.attach.mutationOptions({
      onSuccess: (r) => {
        toast.success(`${r.service} now reads ${r.family} v${r.version}; it restarts one copy at a time`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const staleFamily = families.find((f) => f.staleConsumers > 0);
  const stale = staleFamily?.consumers.find((c) => !c.upToDate);
  if (staleFamily && stale) {
    return (
      <NextAction
        title={`${stale.serviceName} is still reading an old ${staleFamily.family}`}
        tech={`${stale.serviceName} mounts v${stale.version} · current is v${staleFamily.currentVersion} · secrets.attach re-mounts it`}
        actions={
          <Button
            disabled={move.isPending}
            onClick={() => move.mutate({ family: staleFamily.family, service: stale.serviceName })}
          >
            {move.isPending ? 'Moving…' : `Move ${stale.serviceName} to the new one`}
          </Button>
        }
      >
        It changed {relTime(staleFamily.lastRotatedAt)} and the other services picked it up.{' '}
        {stale.serviceName} restarts one copy at a time, so nobody sees a gap.
      </NextAction>
    );
  }

  const loose = rows.find((r) => r.secretLooking);
  if (loose) {
    return (
      <NextAction
        title={`${loose.key} looks like a password, but it's a plain variable`}
        tech={`visible in the service spec of ${loose.services.join(', ')}`}
        actions={<Button onClick={onAddSecret}>Keep it as a secret</Button>}
      >
        Anyone who can read the app's settings can see it. As a secret it becomes a file only your service can read.
      </NextAction>
    );
  }
  return null;
}
