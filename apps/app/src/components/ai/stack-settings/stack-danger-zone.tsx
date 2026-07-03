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
  const stacks = useQuery({ ...trpc.stacks.list.queryOptions(), refetchInterval: 10_000 });
  const id = stacks.data?.find((s) => s.name === stack)?.id;

  const remove = useMutation(
    trpc.stacks.remove.mutationOptions({
      onSuccess: () => {
        toast.success(`${stack} removed`);
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
              Removing {stack} stops and deletes every service in it. Volumes stay behind.
            </p>
          </div>
        </div>

        <AlertDialog onOpenChange={(open) => !open && setConfirm('')}>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" disabled={!id || remove.isPending}>
              {remove.isPending ? 'Removing…' : 'Remove stack'}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {stack}?</AlertDialogTitle>
              <AlertDialogDescription>
                Every service in the stack is stopped and removed from the cluster. This cannot be
                undone. Type <span className="mono-data text-foreground">{stack}</span> to confirm.
              </AlertDialogDescription>
            </AlertDialogHeader>
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
                onClick={() => id && remove.mutate({ id })}
              >
                Remove {stack}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </section>
  );
}
