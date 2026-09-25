import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, toast } from '@swarmy/ui';
import type { HealthStatusView } from '@swarmy/core';
import { NextAction, Say, Tech, usePageDepth } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';

export type ObsState = 'suite-off' | 'app-off' | 'on';

/** The sentence headline for the Logs & traces tab, from live status + health. */
export function obsHeadline(
  stack: string,
  state: ObsState,
  health: { status: HealthStatusView; reasons: string[] } | undefined,
  retentionDays: number | undefined,
): { title: React.ReactNode; lede: React.ReactNode } {
  if (state === 'suite-off') {
    return {
      title: `Logs and traces are off for ${stack}.`,
      lede: 'One switch starts swarmy’s own collector and store. Then every service sends logs, traces and metrics, with nothing to install in the app.',
    };
  }
  if (state === 'app-off') {
    return {
      title: `${stack} isn’t sending logs and traces yet.`,
      lede: 'Turn it on and swarmy adds the OTEL_* environment on the next deploy. Values you set yourself are never overwritten.',
    };
  }
  const kept = retentionDays ? ` Kept for ${retentionDays} days.` : '';
  const first = health?.reasons.find((r) => !r.startsWith('telemetry'));
  if (health?.status === 'down' || health?.status === 'degraded') {
    return {
      title: (
        <>
          {stack} <Say tone={health.status === 'down' ? 'bad' : 'warn'}>needs a look{first ? `: ${first}.` : '.'}</Say>
        </>
      ),
      lede: `${health.reasons.length} ${health.reasons.length === 1 ? 'thing' : 'things'} to check, in plain words below. Every service sends logs, traces and metrics here.${kept}`,
    };
  }
  return {
    title: (
      <>
        {stack} is healthy. <em>Every service sends its logs and traces here.</em>
      </>
    ),
    lede: `Nothing needs you. swarmy watches latency, errors, restarts and database copies for you.${kept}`,
  };
}

/** The one next action for the tab: turn it on, or go look at what's wrong. */
export function ObsNextAction({ stack, state, reason }: { stack: string; state: ObsState; reason: string | null }): React.JSX.Element | null {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const onDone = { onSuccess: () => void qc.invalidateQueries(), onError: (e: { message: string }) => toast.error(e.message) };
  const suite = useMutation(trpc.observability.setEnabled.mutationOptions(onDone));
  const app = useMutation(trpc.observability.enableForStack.mutationOptions(onDone));
  const { setDepth } = usePageDepth();
  const red = !!reason && /error|latency|p95/i.test(reason);
  const show = (): void => {
    setDepth('controls');
    window.setTimeout(() => document.getElementById(red ? 'traces' : 'logs')?.scrollIntoView({ behavior: 'smooth' }), 80);
  };

  if (state === 'suite-off') {
    return (
      <NextAction title="Turn on logs and traces" tone="info" tech="deploys swarmy-otel-collector + ClickHouse under the swarmy-system stack (org-wide)"
        actions={<Button disabled={suite.isPending} onClick={() => suite.mutate({ enabled: true })}>{suite.isPending ? 'Turning on…' : 'Turn on'}</Button>}>
        swarmy runs one collector and one store for the whole workspace. Nothing extra runs while it’s off.
      </NextAction>
    );
  }
  if (state === 'app-off') {
    return (
      <NextAction title={`Send ${stack}’s logs and traces`} tone="info" tech="stamps swarmy.otel.enabled=true · OTEL_* injected on the next deploy"
        actions={<Button disabled={app.isPending} onClick={() => app.mutate({ stackId: stack, enabled: true })}>{app.isPending ? 'Turning on…' : `Turn on for ${stack}`}</Button>}>
        It takes effect on the next deploy. An app that ignores OTEL_* runs exactly as before.
      </NextAction>
    );
  }
  if (!reason) return null;
  return (
    <NextAction title={reason} tone="warn"
      actions={<Button onClick={show}>{red ? 'See the slow and failing requests' : 'Read the logs'}</Button>}
      hint={<Link to="/stacks/$name/errors" params={{ name: stack }} className="hover:text-foreground underline-offset-2 hover:underline">or open Errors</Link>}>
      {red ? 'The traces show where the time goes in each request.' : 'The logs show what the service said before it stopped.'}
      <Tech>health = live tasks + replica lag + queue depth + RED rows (p95 target &lt; 1.5 s, errors &lt; 5 %)</Tech>
    </NextAction>
  );
}
