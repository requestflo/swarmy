import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, toast } from '@swarmy/ui';
import { NextAction } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';

export type ObsState = 'suite-off' | 'app-off' | 'on';

/** The sentence headline while logs and traces are off (the stream writes its own when on). */
export function obsOffHeadline(stack: string, state: Exclude<ObsState, 'on'>): { title: React.ReactNode; lede: React.ReactNode } {
  if (state === 'suite-off') {
    return {
      title: `Logs and traces are off for ${stack}.`,
      lede: 'One switch starts swarmy’s own collector and store. Then every service sends logs, traces and metrics, with nothing to install in the app.',
    };
  }
  return {
    title: `${stack} isn’t sending logs and traces yet.`,
    lede: 'Turn it on and swarmy adds the OTEL_* environment on the next deploy. Values you set yourself are never overwritten.',
  };
}

/** The one next action while it's off: turn it on (org-wide, then for this app). */
export function ObsNextAction({ stack, state }: { stack: string; state: Exclude<ObsState, 'on'> }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const onDone = { onSuccess: () => void qc.invalidateQueries(), onError: (e: { message: string }) => toast.error(e.message) };
  const suite = useMutation(trpc.observability.setEnabled.mutationOptions(onDone));
  const app = useMutation(trpc.observability.enableForStack.mutationOptions(onDone));
  if (state === 'suite-off') {
    return (
      <NextAction title="Turn on logs and traces" tone="info" tech="deploys swarmy-otel-collector + ClickHouse under the swarmy-system stack (org-wide)"
        actions={<Button disabled={suite.isPending} onClick={() => suite.mutate({ enabled: true })}>{suite.isPending ? 'Turning on…' : 'Turn on'}</Button>}>
        swarmy runs one collector and one store for the whole workspace. Nothing extra runs while it’s off.
      </NextAction>
    );
  }
  return (
    <NextAction title={`Send ${stack}’s logs and traces`} tone="info" tech="stamps swarmy.otel.enabled=true · OTEL_* injected on the next deploy"
      actions={<Button disabled={app.isPending} onClick={() => app.mutate({ stackId: stack, enabled: true })}>{app.isPending ? 'Turning on…' : `Turn on for ${stack}`}</Button>}>
      It takes effect on the next deploy. An app that ignores OTEL_* runs exactly as before.
    </NextAction>
  );
}
