import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PlayIcon } from 'lucide-react';
import type { ResilienceDrillKind, ResilienceDrillTargetView } from '@swarmy/core';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { DRILL_TITLES } from './format';

const CONFIRM_COPY: Record<ResilienceDrillKind, string> = {
  restore:
    'This provisions a throwaway drill cluster, restores your latest backup into it, verifies SELECT 1, then destroys the clone. Your live cluster is never touched. Takes a few minutes.',
  'backup-verify':
    'This runs `restic check` against the backup destination in a one-shot container — read-only, safe to run any time.',
};

/** Confirm + run one drill — the sanctioned AlertDialog. Failover needs an explicit "I understand" gate. */
export function RunDrillDialog({
  kind,
  targets,
  disabled,
  disabledReason,
}: {
  kind: ResilienceDrillKind;
  targets: ResilienceDrillTargetView[];
  disabled: boolean;
  disabledReason: string | null;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);

  const pickable = targets;
  const [target, setTarget] = React.useState<string>('');
  const selected = pickable.find((t) => `${t.stack}/${t.cluster}` === target) ?? pickable[0];

  const done = (status: string, summary: string): void => {
    if (status === 'passed') toast.success(summary);
    else toast.error(summary);
    setOpen(false);
    void qc.invalidateQueries();
  };
  const opts = {
    onSuccess: (r: { status: string; summary: string; error: string | null }) =>
      done(r.status, r.error ?? r.summary),
    onError: (e: { message: string }) => toast.error(e.message),
  };
  const restore = useMutation(trpc.resilience.runRestoreDrill.mutationOptions(opts));
  const verify = useMutation(trpc.resilience.runBackupVerify.mutationOptions(opts));
  const pending = restore.isPending || verify.isPending;

  const run = (): void => {
    if (kind === 'backup-verify') return void verify.mutate({});
    if (!selected) return;
    restore.mutate({ stack: selected.stack, cluster: selected.cluster });
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={setOpen}
    >
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={disabled} title={disabledReason ?? undefined}>
          <PlayIcon className="size-3.5" /> Run drill
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Run the {DRILL_TITLES[kind].toLowerCase()}?</AlertDialogTitle>
          <AlertDialogDescription>{CONFIRM_COPY[kind]} Everything is audited.</AlertDialogDescription>
        </AlertDialogHeader>

        {kind !== 'backup-verify' && pickable.length > 0 ? (
          <div className="space-y-2">
            <Label className="text-sm font-medium">Database cluster</Label>
            <Select
              value={target || (selected ? `${selected.stack}/${selected.cluster}` : '')}
              onValueChange={setTarget}
            >
              <SelectTrigger>
                <SelectValue placeholder="Pick a cluster" />
              </SelectTrigger>
              <SelectContent>
                {pickable.map((t) => (
                  <SelectItem key={`${t.stack}/${t.cluster}`} value={`${t.stack}/${t.cluster}`}>
                    {t.stack}/{t.cluster} · {t.topology}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending || (kind !== 'backup-verify' && !selected)}
            onClick={(e) => {
              e.preventDefault();
              run();
            }}
          >
            {pending ? 'Running… this can take a few minutes' : `Run ${DRILL_TITLES[kind].toLowerCase()}`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
