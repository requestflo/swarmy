import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRoundIcon, PlusIcon } from 'lucide-react';
import type { VectorProvisionResult } from '@swarmy/core';
import {
  Button,
  type ButtonProps,
  CopyButton,
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

/**
 * Create-vector wizard. On success the generated API key is shown ONCE —
 * swarmy stores it only as a Docker secret and can never show it again.
 */
export function CreateVectorDialog({
  variant = 'default',
}: {
  variant?: ButtonProps['variant'];
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [stack, setStack] = React.useState('');
  const [name, setName] = React.useState('vectors');
  const [result, setResult] = React.useState<VectorProvisionResult | null>(null);

  const provision = useMutation(
    trpc.vector.provision.mutationOptions({
      onSuccess: (r) => {
        setResult(r);
        toast.success(`Qdrant ${r.name} is provisioning`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const close = (next: boolean): void => {
    setOpen(next);
    if (!next) {
      setStack('');
      setName('vectors');
      setResult(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogTrigger asChild>
        <Button variant={variant}>
          <PlusIcon className="size-4" /> New vector store
        </Button>
      </DialogTrigger>
      <DialogContent>
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle>It&apos;s provisioning.</DialogTitle>
              <DialogDescription>
                Save the API key now — it lives only in the Docker secret{' '}
                <code className="mono-data">{result.keySecret}</code> and can&apos;t be shown again.
                Attached apps read it from the secret file automatically.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <div className="bg-muted/40 flex items-center justify-between gap-2 rounded-md px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <KeyRoundIcon className="text-muted-foreground size-4 shrink-0" />
                  <code className="mono-data truncate text-xs">{result.apiKey}</code>
                </div>
                <CopyButton value={result.apiKey} />
              </div>
              <div className="bg-muted/40 flex items-center justify-between gap-2 rounded-md px-3 py-2">
                <code className="mono-data truncate text-xs">{result.url}</code>
                <CopyButton value={result.url} />
              </div>
            </div>
            <DialogFooter>
              <Button onClick={() => close(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>New vector store</DialogTitle>
              <DialogDescription>
                Qdrant v1.12 on your swarm — private by default, API key in a Docker secret,
                volume-backed storage, no published ports.
              </DialogDescription>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label className="mono-label">Stack</Label>
                <Input value={stack} onChange={(e) => setStack(e.target.value)} placeholder="shop" />
              </div>
              <div className="grid gap-1.5">
                <Label className="mono-label">Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="vectors" />
              </div>
            </div>
            <DialogFooter>
              <Button
                onClick={() => provision.mutate({ stack: stack.trim(), name: name.trim() })}
                disabled={provision.isPending || !stack.trim() || !name.trim()}
              >
                {provision.isPending ? 'Provisioning…' : 'Create vector store'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
