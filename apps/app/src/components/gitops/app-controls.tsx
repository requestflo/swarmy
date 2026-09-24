import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RocketIcon } from 'lucide-react';
import { Button, Label, Switch, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import type { GitApp } from './gitops-types';
import { planStatus } from './plan-status';

/** Per-app knobs: hold every change for a human, and deploy the branch head right now. */
export function AppControls({ app }: { app: GitApp }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const refresh = (): void => void qc.invalidateQueries({ queryKey: trpc.apps.pathKey() });
  const approval = useMutation(
    trpc.apps.setRequireApproval.mutationOptions({
      onSuccess: (r) => {
        toast.success(
          r.requireApproval
            ? 'Every change now waits for a confirm.'
            : 'Safe changes ship on push again.',
        );
        refresh();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const deploy = useMutation(
    trpc.apps.deploy.mutationOptions({
      onSuccess: (r) => {
        const words = planStatus(r.status).label;
        toast.success(
          r.reason ? `${words}: ${r.reason}` : `Deploying ${app.branch} — ${words.toLowerCase()}.`,
        );
        refresh();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const id = `approval-${app.repoId}`;

  return (
    <div className="flex flex-wrap items-center gap-4">
      <div className="flex items-center gap-2">
        <Switch
          id={id}
          checked={app.requireApproval}
          disabled={approval.isPending}
          onCheckedChange={(v) => approval.mutate({ repoId: app.repoId, requireApproval: v })}
        />
        <Label htmlFor={id} className="text-sm">
          Require approval
        </Label>
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled={deploy.isPending}
        onClick={() => deploy.mutate({ repoId: app.repoId })}
      >
        <RocketIcon className="size-4" /> {deploy.isPending ? 'Deploying…' : 'Deploy now'}
      </Button>
    </div>
  );
}
