import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { NextAction } from '@/components/calm';
import { AbandonDialog } from './abandon-dialog';
import { pausedNext, pausedTitle } from './pause-words';
import { STEP_TEXT, type PlatformRun } from './use-platform';

/**
 * A paused upgrade — Resume is the one action, Abandon asks first — or one
 * being put back after Abandon (it carries on while swarmy restarts itself).
 */
export function RunPaused({ run, admin }: { run: PlatformRun; admin: boolean }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const resume = useMutation(
    trpc.platform.resume.mutationOptions({
      onSuccess: () => void qc.invalidateQueries(),
      onError: (e) => toast.error(e.message),
    }),
  );
  const step = STEP_TEXT[run.step]?.name ?? run.step;
  const detail = run.steps.find((s) => s.key === run.step)?.detail;

  if (run.status === 'abandoning') {
    return (
      <NextAction
        tone="info"
        eyebrow="Putting back"
        title={`Putting ${step.toLowerCase()} back on ${run.fromVersion}.`}
        tech={`run ${run.id} · abandoning ${run.fromVersion} → ${run.toVersion}${detail ? ` · ${detail}` : ''}`}
      >
        One piece at a time, each health-checked. You can close this tab; it keeps going.
      </NextAction>
    );
  }

  const kept = run.abandon?.kept.map((k) => `${k.key}: ${k.why}`).join(' · ');
  return (
    <NextAction
      tone={run.error ? 'bad' : 'warn'}
      eyebrow="Paused"
      title={pausedTitle(run)}
      tech={`run ${run.id} · ${run.fromVersion} → ${run.toVersion} · next: ${run.step}${kept ? ` · on Abandon, kept — ${kept}` : ''}`}
      actions={
        admin ? (
          <>
            <Button className="pointer-coarse:min-h-11" onClick={() => resume.mutate({ id: run.id })} disabled={resume.isPending}>
              Resume with {step.toLowerCase()}
            </Button>
            <AbandonDialog run={run} />
          </>
        ) : undefined
      }
    >
      {run.error ? <span className="text-tone-bad block">{run.error}</span> : null}
      {pausedNext(run)}
    </NextAction>
  );
}
