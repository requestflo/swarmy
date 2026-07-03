import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2Icon } from 'lucide-react';
import type { SearchInstanceView } from '@swarmy/core';
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

/** Destructive confirm (the one sanctioned modal): type-the-name, then destroy. */
export function DestroySearchDialog({
  view,
  onDestroyed,
}: {
  view: SearchInstanceView;
  onDestroyed: () => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [confirm, setConfirm] = React.useState('');
  const attached = view.attachments.length;

  const destroy = useMutation(
    trpc.search.destroy.mutationOptions({
      onSuccess: () => {
        toast.success(`Search instance ${view.name} destroyed`);
        onDestroyed();
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <AlertDialog onOpenChange={(o) => { if (!o) setConfirm(''); }}>
      <AlertDialogTrigger asChild>
        <Button variant="outline" className="border-status-offline/40 text-status-offline">
          <Trash2Icon className="size-4" /> Destroy instance
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Destroy {view.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Removes the {view.engine} service and the master-key secret. The data volume stays
            behind (restorable from snapshots).
            {attached > 0
              ? ` ${attached} app(s) are still attached and will lose search — they'll be detached by force.`
              : ''}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-1.5">
          <Label className="mono-label">
            Type <code className="mono-data">{view.name}</code> to confirm
          </Label>
          <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={view.name} />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={confirm !== view.name || destroy.isPending}
            onClick={() =>
              destroy.mutate({ stack: view.stack, name: view.name, force: attached > 0 })
            }
          >
            {destroy.isPending ? 'Destroying…' : 'Destroy'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
