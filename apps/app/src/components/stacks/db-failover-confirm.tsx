import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldAlertIcon } from 'lucide-react';
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
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/** Mirrors @swarmy/core `PendingFailover` (the `swarmy.db.failover.pending` label). */
export interface DbPendingFailoverView {
  target: string;
  behindBytes: number | null;
  behindSeconds: number | null;
  reason: string;
  since: string;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Plain-words data-loss window: "4.0 KiB (about 2.5 s of writes)" / "an unknown amount". */
export function lossWindow(p: DbPendingFailoverView): string {
  if (p.behindBytes === null) return 'an unknown amount of the most recent writes';
  const secs = p.behindSeconds !== null ? ` (about ${p.behindSeconds} s of writes)` : '';
  return `${formatBytes(p.behindBytes)} of the most recent writes${secs}`;
}

/**
 * The primary is down and swarmy HELD the failover: no replica is provably
 * caught up, so promoting one could lose the last writes. Shows the data-loss
 * window and lets an owner/admin (`data.failover` policy) confirm promoting the
 * named replica. The worker re-checks the window before it promotes — if the
 * gap has grown past what was accepted, the confirmation no longer applies.
 */
export function DbFailoverConfirm({
  stack,
  cluster,
  pending,
}: {
  stack: string;
  cluster: string;
  pending: DbPendingFailoverView;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const confirm = useMutation(
    trpc.db.confirmFailover.mutationOptions({
      onSuccess: (res) => {
        toast.success(`Failover confirmed — ${res.target} is promoted on the next check (≈15 s)`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const window = lossWindow(pending);

  return (
    <div
      role="alert"
      className="border-status-offline/40 bg-status-offline/10 text-tone-bad flex flex-wrap items-start justify-between gap-3 rounded-lg border p-3 text-sm"
    >
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <ShieldAlertIcon className="mt-0.5 size-4 shrink-0" />
        <span>
          The primary is down. swarmy did not fail over on its own because promoting{' '}
          <span className="font-mono">{pending.target}</span> could lose {window}. Bring the
          primary back to lose nothing, or confirm the failover.
        </span>
      </div>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button size="sm" variant="outline" disabled={confirm.isPending}>
            {confirm.isPending ? 'Confirming…' : 'Review failover'}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Promote {pending.target} and accept the data loss?</AlertDialogTitle>
            <AlertDialogDescription>
              {cluster} would lose {window} that the old primary had written but this replica
              never received. Why swarmy held it: {pending.reason}. If the old primary comes
              back later it rejoins as a replica — its unreplicated writes are not merged.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep waiting</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                confirm.mutate({
                  stack,
                  cluster,
                  target: pending.target,
                  acceptBehindBytes: pending.behindBytes ?? 'unknown',
                })
              }
            >
              Promote and accept the loss
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
