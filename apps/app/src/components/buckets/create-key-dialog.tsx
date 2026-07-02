import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyIcon } from 'lucide-react';
import type { BucketKeyCreatedView } from '@swarmy/core';
import {
  Button,
  CopyButton,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/**
 * Mint an access key. On success the dialog flips to a reveal-ONCE view —
 * the secret is never retrievable again, so it must be copied now.
 */
export function CreateKeyDialog(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [created, setCreated] = React.useState<BucketKeyCreatedView | null>(null);

  const create = useMutation(
    trpc.buckets.createKey.mutationOptions({
      onSuccess: (k) => {
        setCreated(k);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const close = (next: boolean): void => {
    setOpen(next);
    if (!next) {
      setName('');
      setCreated(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <KeyIcon className="size-4" /> New key
        </Button>
      </DialogTrigger>
      <DialogContent>
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Copy the secret — shown once</DialogTitle>
            </DialogHeader>
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label className="mono-label">Access key id</Label>
                <div className="flex items-center gap-2">
                  <code className="mono-data bg-accent min-w-0 flex-1 truncate rounded-md px-3 py-2 text-sm">
                    {created.accessKeyId}
                  </code>
                  <CopyButton value={created.accessKeyId} />
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label className="mono-label">Secret access key</Label>
                <div className="flex items-center gap-2">
                  <code className="mono-data bg-accent min-w-0 flex-1 truncate rounded-md px-3 py-2 text-sm">
                    {created.secretAccessKey}
                  </code>
                  <CopyButton value={created.secretAccessKey} />
                </div>
                <p className="text-status-warning text-xs font-medium">
                  This secret will not be shown again. Store it somewhere safe now.
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={() => close(false)}>Done — I copied it</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Create an access key</DialogTitle>
            </DialogHeader>
            <div className="grid gap-1.5">
              <Label className="mono-label">Key name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="ci-uploader"
                autoFocus
              />
              <p className="text-muted-foreground text-xs">
                Keys start with no access — grant them per-bucket read/write/owner after creating.
              </p>
            </div>
            <DialogFooter>
              <Button
                onClick={() => create.mutate({ name })}
                disabled={create.isPending || name.trim().length === 0}
              >
                {create.isPending ? 'Creating…' : 'Create key'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
