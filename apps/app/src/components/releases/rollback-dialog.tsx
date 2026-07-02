import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Undo2Icon } from 'lucide-react';
import type { ReleaseView } from '@swarmy/core';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Label,
  Switch,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { relativeTime } from './release-status';

/**
 * Confirmed rollback: redeploys this release's compose as a NEW release. When
 * the deploy is refused by policy, the violations are surfaced and an audited
 * override is offered (block-level overrides need an admin).
 */
export function RollbackDialog({ release }: { release: ReleaseView }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [override, setOverride] = React.useState(false);

  const rollback = useMutation(
    trpc.releases.rollback.mutationOptions({
      onSuccess: () => {
        toast.success(`Rolling ${release.stackName} back — a new release is deploying.`);
        setOpen(false);
        setOverride(false);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const policyRefused = rollback.isError && /blocked by policy/i.test(rollback.error.message);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setOverride(false);
          rollback.reset();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Undo2Icon className="size-4" /> Roll back to this release
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Roll back {release.stackName}?</DialogTitle>
          <DialogDescription>
            Redeploys the compose from {relativeTime(release.createdAt)} as a new release. The
            current head release is marked rolled back. Everything is audited.
          </DialogDescription>
        </DialogHeader>

        {rollback.isError ? (
          <div className="border-status-offline/40 bg-status-offline/12 rounded-xl border px-4 py-3">
            <p className="text-status-offline whitespace-pre-wrap text-xs">{rollback.error.message}</p>
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

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={rollback.isPending || (policyRefused && !override)}
            onClick={() => rollback.mutate({ releaseId: release.id, override })}
          >
            {rollback.isPending ? 'Rolling back…' : 'Roll back'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
