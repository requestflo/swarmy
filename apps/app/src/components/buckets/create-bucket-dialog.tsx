import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import {
  Button,
  type ButtonProps,
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

/** Coral CTA + name-a-bucket dialog. Owns the createBucket mutation. */
export function CreateBucketDialog({
  variant = 'default',
}: {
  variant?: ButtonProps['variant'];
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');

  const create = useMutation(
    trpc.buckets.createBucket.mutationOptions({
      onSuccess: (b) => {
        toast.success(`Bucket "${b.name}" created`);
        setOpen(false);
        setName('');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const valid = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={variant}>
          <PlusIcon className="size-4" /> New bucket
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a bucket</DialogTitle>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label className="mono-label">Bucket name</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase())}
            placeholder="app-uploads"
            autoFocus
          />
          <p className="text-muted-foreground text-xs">
            3–63 chars: lowercase letters, digits, dots, dashes. Private by default — apps get
            access via scoped keys.
          </p>
        </div>
        <DialogFooter>
          <Button onClick={() => create.mutate({ name })} disabled={create.isPending || !valid}>
            {create.isPending ? 'Creating…' : 'Create bucket'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
