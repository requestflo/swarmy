import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { Trash2Icon } from 'lucide-react';
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
import { SettingRow } from './settings-row';

/** The one irreversible action, kept quiet at Controls and behind a confirm. */
export function RemovePartRow({ serviceId, name, stack }: { serviceId: string; name: string; stack: string | null }): React.JSX.Element {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const remove = useMutation(
    trpc.services.remove.mutationOptions({
      onSuccess: () => {
        toast.success(`${name} removed`);
        void (stack ? navigate({ to: '/stacks/$name', params: { name: stack } }) : navigate({ to: '/' }));
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  return (
    <SettingRow title="Remove this part">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground text-[13px]">Stops every copy and deletes it. Its data volumes stay put.</p>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline" size="sm" className="border-status-offline/40 text-tone-bad pointer-coarse:min-h-11">
              <Trash2Icon className="size-4" /> Remove
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {name}?</AlertDialogTitle>
              <AlertDialogDescription>Stops every copy and deletes this part. No undo.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction disabled={remove.isPending} onClick={() => remove.mutate({ id: serviceId })}>
                {remove.isPending ? 'Removing…' : 'Remove'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </SettingRow>
  );
}
