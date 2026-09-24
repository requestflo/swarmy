import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2Icon } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

interface PurgeDataDialogProps {
  repoId: string;
  environment: string;
  stack: string;
  resource: string;
  /** The data is gone — the caller stops offering this. */
  onPurged?: () => void;
}

/** Delete a removed Postgres's kept volume for good — only after typing `<stack>/<resource>`. */
export function PurgeDataDialog({
  repoId,
  environment,
  stack,
  resource,
  onPurged,
}: PurgeDataDialogProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const expected = `${stack}/${resource}`;
  const [open, setOpen] = React.useState(false);
  const [typed, setTyped] = React.useState('');
  const purge = useMutation(
    trpc.apps.purgeData.mutationOptions({
      onSuccess: (r) => {
        toast.success(
          `Deleted ${r.resource}'s data from ${r.nodes} server${r.nodes === 1 ? '' : 's'}.`,
        );
        setOpen(false);
        onPurged?.();
        void qc.invalidateQueries({ queryKey: trpc.apps.pathKey() });
      },
      // FORBIDDEN / "still declared" / "still running" come back in plain words.
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setTyped('');
      }}
    >
      <DialogTrigger asChild>
        <Button variant="destructive" size="sm">
          <Trash2Icon className="size-4" /> Delete data permanently
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {resource}’s data for good?</DialogTitle>
          <DialogDescription>
            The database is already removed; its volume was kept in case you changed your mind. This
            deletes that volume on every server. There’s no undo, and backups are the only way back.
          </DialogDescription>
        </DialogHeader>
        <label className="grid gap-1.5 text-sm">
          <span>
            Type <span className="mono-data font-semibold">{expected}</span> to confirm
          </span>
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="mono-data"
            autoComplete="off"
          />
        </label>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Keep the data
          </Button>
          <Button
            variant="destructive"
            disabled={typed !== expected || purge.isPending}
            onClick={() => purge.mutate({ repoId, environment, resource, confirm: typed })}
          >
            {purge.isPending ? 'Deleting…' : 'Delete permanently'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
