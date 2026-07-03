import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2Icon } from 'lucide-react';
import type { CacheClusterView } from '@swarmy/core';
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
export function DestroyCacheDialog({
  view,
  onDestroyed,
}: {
  view: CacheClusterView;
  onDestroyed: () => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [confirm, setConfirm] = React.useState('');
  const attached = view.attachments.length;

  const destroy = useMutation(
    trpc.cache.destroy.mutationOptions({
      onSuccess: () => {
        toast.success(`Cache ${view.name} destroyed`);
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
          <Trash2Icon className="size-4" /> Destroy cluster
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Destroy {view.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Removes the primary{view.replicas.desired > 0 ? ', replicas' : ''}
            {view.sentinels.desired > 0 ? ', sentinels' : ''} and the password secret. The data
            volume stays behind (restorable from snapshots).
            {attached > 0
              ? ` ${attached} app(s) are still attached and will lose their cache — they'll be detached by force.`
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
              destroy.mutate({ stack: view.stack, cluster: view.name, force: attached > 0 })
            }
          >
            {destroy.isPending ? 'Destroying…' : 'Destroy'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
