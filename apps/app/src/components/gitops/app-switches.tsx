import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Label, Switch, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import type { GitApp } from './gitops-types';

function Toggle({
  id,
  label,
  hint,
  checked,
  pending,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  pending: boolean;
  onChange: (v: boolean) => void;
}): React.JSX.Element {
  return (
    <div className="flex max-w-xs items-start gap-2">
      <Switch
        id={id}
        checked={checked}
        disabled={pending}
        onCheckedChange={onChange}
        className="mt-0.5"
      />
      <div>
        <Label htmlFor={id} className="text-sm">
          {label}
        </Label>
        <p className="text-muted-foreground text-xs">{hint}</p>
      </div>
    </div>
  );
}

/** Per-app policy: hold every change for a human; put drifted git-owned settings back on their own. */
export function AppSwitches({ app }: { app: GitApp }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const refresh = (): void => void qc.invalidateQueries({ queryKey: trpc.apps.pathKey() });
  const onError = (e: { message: string }): void => void toast.error(e.message);
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
      onError,
    }),
  );
  const enforce = useMutation(
    trpc.apps.setEnforceDrift.mutationOptions({
      onSuccess: (r) => {
        toast.success(
          r.enforceDrift ? 'Drift gets put back automatically.' : 'Drift is reported, not fixed.',
        );
        refresh();
      },
      onError,
    }),
  );

  return (
    <div className="flex flex-wrap items-center gap-4">
      <Toggle
        id={`approval-${app.repoId}`}
        label="Require approval"
        hint="Every change waits for a confirm, not only destructive ones."
        checked={app.requireApproval}
        pending={approval.isPending}
        onChange={(v) => approval.mutate({ repoId: app.repoId, requireApproval: v })}
      />
      <Toggle
        id={`enforce-${app.repoId}`}
        label="Fix drift"
        hint="Put git-owned settings back automatically when they drift (destructive changes still wait for you)."
        checked={app.enforceDrift}
        pending={enforce.isPending}
        onChange={(v) => enforce.mutate({ repoId: app.repoId, enforceDrift: v })}
      />
    </div>
  );
}
