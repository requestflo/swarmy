import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { TriangleAlertIcon } from 'lucide-react';
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
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

interface StackDangerZoneProps {
  stack: string;
}

/** Danger zone: remove the stack, gated by typing its name into the confirm. */
export function StackDangerZone({ stack }: StackDangerZoneProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [confirm, setConfirm] = React.useState('');
  // "Also delete this app's data" — off by default: the data and the passwords
  // it was set up with are kept, so deploying the same name picks them back up.
  const [deleteData, setDeleteData] = React.useState(false);
  const stacks = useQuery({ ...trpc.stacks.list.queryOptions(), refetchInterval: 10_000 });
  const id = stacks.data?.find((s) => s.name === stack)?.id;

  const remove = useMutation(
    trpc.stacks.remove.mutationOptions({
      onSuccess: (res) => {
        toast.success(res.deleteData ? `${stack} and its data removed` : `${stack} removed · its data is kept`);
        void qc.invalidateQueries();
        void navigate({ to: '/' });
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <section className="border-destructive/30 rounded-2xl border p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="bg-destructive/10 text-destructive flex size-9 items-center justify-center rounded-lg">
            <TriangleAlertIcon className="size-5" />
          </span>
          <div>
            <p className="font-semibold">Danger zone</p>
            <p className="text-muted-foreground text-xs">
              Removing {stack} stops and deletes every service in it. Its data stays unless you say
              otherwise.
            </p>
          </div>
        </div>

        <AlertDialog
          onOpenChange={(open) => {
            if (!open) {
              setConfirm('');
              setDeleteData(false);
            }
          }}
        >
          <AlertDialogTrigger asChild>
            <Button variant="outline" className="text-tone-bad" disabled={!id || remove.isPending}>
              {remove.isPending ? 'Removing…' : 'Remove stack'}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {stack}?</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="grid gap-2 text-sm">
                  <p>Every service in {stack} is stopped and removed. This cannot be undone.</p>
                  <p>
                    {deleteData
                      ? 'Its data goes too: the saved files and databases on your servers, and the passwords swarmy made for it.'
                      : 'Its data is kept: the saved files and databases stay on your servers with their passwords, so deploying the same name again picks them back up.'}
                  </p>
                  <p>
                    Type <span className="mono-data text-foreground">{stack}</span> to confirm.
                  </p>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="accent-primary size-4"
                checked={deleteData}
                onChange={(e) => setDeleteData(e.target.checked)}
              />
              <span className={deleteData ? 'text-tone-bad' : undefined}>Also delete this app's data</span>
            </label>
            <Input
              autoFocus
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder={stack}
              aria-label={`Type ${stack} to confirm`}
            />
            <AlertDialogFooter>
              <AlertDialogCancel>Keep the stack</AlertDialogCancel>
              <AlertDialogAction
                disabled={confirm !== stack || !id}
                onClick={() => id && remove.mutate({ id, deleteData })}
              >
                {deleteData ? `Remove ${stack} and its data` : `Remove ${stack}`}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </section>
  );
}
