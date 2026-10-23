import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { GitBranchIcon } from 'lucide-react';
import { Button, toast } from '@swarmy/ui';
import { TONE_TEXT, Tech } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import type { AppDriftState } from './use-app-drift';

const ago = (iso: string): string => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

/**
 * "Changed here, not in swarmy.yaml" (board AppScaling) for a git-managed
 * app whose live state differs from the last applied commit. With Fix drift
 * on, swarmy puts swarmy.yaml back at its next check, so the one action is
 * "Override until next push" (Fix drift off for the app). With it off the
 * change already stays until the next push, so there is nothing to press.
 */
export function DriftBanner({ stack, drift }: { stack: string; drift: AppDriftState }): React.JSX.Element | null {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const override = useMutation(
    trpc.apps.setEnforceDrift.mutationOptions({
      onSuccess: () => {
        toast.success('Kept. The next push puts swarmy.yaml back.');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const { git, changes } = drift;
  if (!git || !changes) return null;
  const { app, env } = git;
  const sha = env.latest?.sha.slice(0, 7);
  const enforced = app.enforceDrift;
  return (
    <div role="status" className="border-status-warning/40 bg-status-warning/10 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border px-4 py-3">
      <GitBranchIcon aria-hidden className={`size-4 shrink-0 ${TONE_TEXT.warn}`} />
      <div className="flex min-w-0 flex-1 basis-64 flex-col gap-0.5">
        <p className="text-[13.5px] font-semibold">Changed here, not in swarmy.yaml</p>
        <p className="text-muted-foreground text-[13px]">
          {changes === 1 ? 'One change' : `${changes} changes`} in {stack} {changes === 1 ? 'isn’t' : 'aren’t'} in {app.configPath}
          {sha ? ` @ ${sha}` : ''}.{' '}
          {enforced
            ? 'swarmy puts swarmy.yaml back at its next check (every 10 minutes).'
            : `${changes === 1 ? 'It stays' : 'They stay'} until the next push to ${env.branch}, which puts swarmy.yaml back.`}
        </p>
        <Tech>
          {`apps.drift · ${env.environment} · checked ${drift.checkedAt ? ago(drift.checkedAt) : 'never'} · enforceDrift ${enforced}`}
          {enforced ? ' · override = apps.setEnforceDrift false (report only, whole app)' : ''}
        </Tech>
      </div>
      {enforced ? (
        <Button
          variant="outline"
          size="sm"
          className="pointer-coarse:min-h-11"
          disabled={override.isPending}
          onClick={() => override.mutate({ repoId: app.repoId, enforceDrift: false })}
        >
          Override until next push
        </Button>
      ) : (
        <span className={`${TONE_TEXT.warn} font-mono text-[11.5px]`}>Overridden · next push reverts</span>
      )}
    </div>
  );
}
