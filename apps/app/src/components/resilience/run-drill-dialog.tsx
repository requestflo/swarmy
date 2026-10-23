import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PlayIcon } from 'lucide-react';
import type { ResilienceDrillKind, ResilienceDrillResultView, ResilienceDrillTargetView } from '@swarmy/core';
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
  label = 'Run drill',
  variant = 'outline',
  onStart,
  onResult,
  onFailed,
}: {
  kind: ResilienceDrillKind;
  targets: ResilienceDrillTargetView[];
  disabled: boolean;
  disabledReason: string | null;
  /** Trigger text ("Run a DR drill"). */
  label?: string;
  /** `default` only when this is the screen's one coral action. */
  variant?: 'default' | 'outline';
  /** Called once the person confirms (the card shows its own running state). */
  onStart?: () => void;
  /** The recorded outcome, for cards that show the steps. */
  onResult?: (r: ResilienceDrillResultView) => void;
  /** A precondition refused it (nothing was touched). */
  onFailed?: (message: string) => void;
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
    onSuccess: (r: ResilienceDrillResultView) => {
      onResult?.(r);
      done(r.status, r.error ?? r.summary);
    },
    onError: (e: { message: string }) => {
      onFailed?.(e.message);
      toast.error(e.message);
    },
  };
  const restore = useMutation(trpc.resilience.runRestoreDrill.mutationOptions(opts));
  const verify = useMutation(trpc.resilience.runBackupVerify.mutationOptions(opts));
  const pending = restore.isPending || verify.isPending;

  const run = (): void => {
    if (kind === 'backup-verify') {
      onStart?.();
      return void verify.mutate({});
    }
    if (!selected) return;
    onStart?.();
    restore.mutate({ stack: selected.stack, cluster: selected.cluster });
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={setOpen}
    >
      <AlertDialogTrigger asChild>
        <Button size="sm" variant={variant} disabled={disabled || pending} title={disabledReason ?? undefined}>
          <PlayIcon className="size-3.5" /> {label}
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
