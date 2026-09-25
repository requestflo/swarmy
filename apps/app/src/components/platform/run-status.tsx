import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Progress, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { NextAction } from '@/components/calm';
import { STEP_TEXT, type PlatformRun } from './use-platform';

/** A run in flight (progress) or one that stopped (retry is the one action). */
export function RunStatus({ run, admin }: { run: PlatformRun; admin: boolean }): React.JSX.Element | null {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const done = { onSuccess: () => void qc.invalidateQueries(), onError: (e: { message: string }) => toast.error(e.message) };
  const retry = useMutation(trpc.platform.retry.mutationOptions(done));
  const cancel = useMutation(trpc.platform.cancel.mutationOptions(done));
  const step = STEP_TEXT[run.step]?.name ?? run.step;
  if (run.status === 'running') {
    const pct = Math.round((run.progress.done / run.progress.total) * 100);
    return (
      <NextAction tone="info" eyebrow="Upgrading" title={`${step}: ${run.steps.find((s) => s.key === run.step)?.detail ?? 'in progress'}`} tech={`run ${run.id} · ${run.fromVersion} → ${run.toVersion}`}>
        <Progress value={pct} aria-label="Upgrade progress" className="my-1" />
        <span className="text-xs">Step {Math.min(run.progress.done + 1, run.progress.total)} of {run.progress.total}. You can close this tab; it keeps going while swarmy restarts itself.</span>
      </NextAction>
    );
  }
  if (run.status !== 'failed') return null;
  return (
    <NextAction
      tone="bad"
      title={`The upgrade stopped at ${step}.`}
      tech={run.error ?? undefined}
      actions={
        admin ? (
          <>
            <Button className="pointer-coarse:min-h-11" onClick={() => retry.mutate({ id: run.id })} disabled={retry.isPending}>Retry from this step</Button>
            <Button variant="ghost" className="pointer-coarse:min-h-11" onClick={() => cancel.mutate({ id: run.id })} disabled={cancel.isPending}>Dismiss</Button>
          </>
        ) : undefined
      }
    >
      Everything before it finished; that piece was put back as it was. Retry picks up from there.
    </NextAction>
  );
}
