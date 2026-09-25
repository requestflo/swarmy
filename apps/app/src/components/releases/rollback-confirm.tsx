import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Undo2Icon } from 'lucide-react';
import type { ReleaseView } from '@swarmy/core';
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
  Switch,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { relativeTime } from './release-status';

/**
 * Destructive confirm for rollback — the one sanctioned modal. Redeploys this
 * release's compose as a NEW release. When the deploy is refused by policy,
 * the violations surface inline and an audited override is offered
 * (block-level overrides need an admin).
 */
export function RollbackConfirm({
  release,
  trigger,
  label,
}: {
  release: ReleaseView;
  /** Custom trigger (e.g. the page's coral "Put back v1.8.2"); defaults to a quiet button. */
  trigger?: React.ReactElement;
  /** The version's name in the dialog ("v1.8.2"). */
  label?: string;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [override, setOverride] = React.useState(false);

  const rollback = useMutation(
    trpc.releases.rollback.mutationOptions({
      onSuccess: () => {
        toast.success(`Putting ${label ?? 'the earlier version'} of ${release.stackName} back, one copy at a time.`);
        setOpen(false);
        setOverride(false);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const policyRefused = rollback.isError && /blocked by policy/i.test(rollback.error.message);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setOverride(false);
          rollback.reset();
        }
      }}
    >
      <AlertDialogTrigger asChild>
        {trigger ?? (
          <Button variant="outline" size="sm">
            <Undo2Icon className="size-4" /> Put this version back
          </Button>
        )}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Put back {label ?? 'this version'} of {release.stackName}?</AlertDialogTitle>
          <AlertDialogDescription>
            Runs the version from {relativeTime(release.createdAt)} again, one copy at a time. The
            current version is marked put back. Everything is audited.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {rollback.isError ? (
          <div className="border-status-offline/40 bg-status-offline/12 rounded-xl border px-4 py-3">
            <p className="text-tone-bad whitespace-pre-wrap text-xs">{rollback.error.message}</p>
          </div>
        ) : null}

        {policyRefused ? (
          <div className="flex items-center justify-between gap-4 rounded-xl border px-4 py-3">
            <div>
              <Label className="text-sm font-medium">Override policy and deploy anyway</Label>
              <p className="text-muted-foreground text-xs">
                Overrides are audited. Blocking violations need an admin or owner.
              </p>
            </div>
            <Switch checked={override} onCheckedChange={setOverride} />
          </div>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={rollback.isPending || (policyRefused && !override)}
            onClick={(e) => {
              e.preventDefault();
              rollback.mutate({ releaseId: release.id, override });
            }}
          >
            {rollback.isPending ? 'Putting back…' : `Put back ${label ?? ''}`.trim()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
