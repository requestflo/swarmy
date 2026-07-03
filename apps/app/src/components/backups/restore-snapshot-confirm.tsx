import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RotateCcwIcon } from 'lucide-react';
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
  Input,
  Label,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

interface RestoreSnapshotConfirmProps {
  snapshotId: string;
  volume: string;
  disabled?: boolean;
}

/**
 * Restore confirm — the one sanctioned modal (destructive: overwrites the
 * destination volume). Carries the target-volume field inline.
 */
export function RestoreSnapshotConfirm({
  snapshotId,
  volume,
  disabled,
}: RestoreSnapshotConfirmProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [targetVolume, setTargetVolume] = React.useState('');

  const restore = useMutation(
    trpc.backups.restoreSnapshot.mutationOptions({
      onSuccess: (r) => {
        toast.success(`Restored to ${r.targetVolume}`);
        setOpen(false);
        setTargetVolume('');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" className="rounded-full" disabled={disabled}>
          <RotateCcwIcon className="size-4" /> Restore
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Restore {volume}?</AlertDialogTitle>
          <AlertDialogDescription>
            The destination volume is overwritten with this snapshot. Keep the name to restore in
            place, or point it at a fresh volume to restore alongside.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-1.5">
          <Label className="mono-label" htmlFor={`restore-${snapshotId}`}>
            Destination volume
          </Label>
          <Input
            id={`restore-${snapshotId}`}
            value={targetVolume}
            onChange={(e) => setTargetVolume(e.target.value)}
            placeholder={volume}
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={restore.isPending}
            onClick={(e) => {
              e.preventDefault();
              restore.mutate({ snapshotId, targetVolume: targetVolume.trim() || undefined });
            }}
          >
            {restore.isPending ? 'Restoring…' : 'Restore snapshot'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
