import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2Icon } from 'lucide-react';
import type { SearchInstanceView } from '@swarmy/core';
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
  Label,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/** Danger zone: type-the-name confirm, then remove the engine + the key secret. */
export function DestroySearchDialog({
  view,
  onDestroyed,
}: {
  view: SearchInstanceView;
  onDestroyed: () => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [confirm, setConfirm] = React.useState('');
  const attached = view.attachments.length;

  const destroy = useMutation(
    trpc.search.destroy.mutationOptions({
      onSuccess: () => {
        toast.success(`Search instance ${view.name} destroyed`);
        setOpen(false);
        onDestroyed();
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setConfirm(''); }}>
      <DialogTrigger asChild>
        <Button variant="outline" className="border-status-offline/40 text-status-offline">
          <Trash2Icon className="size-4" /> Destroy instance
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Destroy {view.name}?</DialogTitle>
          <DialogDescription>
            Removes the {view.engine} service and the master-key secret. The data volume stays
            behind (restorable from snapshots).
            {attached > 0
              ? ` ${attached} app(s) are still attached and will lose search — they'll be detached by force.`
              : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label className="mono-label">
            Type <code className="mono-data">{view.name}</code> to confirm
          </Label>
          <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={view.name} />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            className="border-status-offline/40 text-status-offline"
            disabled={confirm !== view.name || destroy.isPending}
            onClick={() =>
              destroy.mutate({
                stack: view.stack,
                name: view.name,
                force: attached > 0,
              })
            }
          >
            {destroy.isPending ? 'Destroying…' : 'Destroy'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
