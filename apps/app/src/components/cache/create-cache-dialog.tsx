import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRoundIcon, PlusIcon } from 'lucide-react';
import type { CacheProvisionResult } from '@swarmy/core';
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
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { parseRegionPlans } from './cache-region-field';
import { CreateCacheFields, EMPTY_DRAFT, type CacheDraft } from './create-cache-fields';

/**
 * Create-cache wizard. On success it shows the generated password ONCE —
 * swarmy stores it only as a Docker secret and can never show it again.
 */
export function CreateCacheDialog({
  variant = 'default',
}: {
  variant?: ButtonProps['variant'];
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<CacheDraft>(EMPTY_DRAFT);
  const [result, setResult] = React.useState<CacheProvisionResult | null>(null);

  const provision = useMutation(
    trpc.cache.provision.mutationOptions({
      onSuccess: (r) => {
        setResult(r);
        toast.success(`Cache ${r.cluster} is provisioning`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const close = (next: boolean): void => {
    setOpen(next);
    if (!next) {
      setDraft(EMPTY_DRAFT);
      setResult(null);
    }
  };

  const submit = (): void => {
    provision.mutate({
      stack: draft.stack.trim(),
      name: draft.name.trim(),
      engine: draft.engine,
      topology: draft.topology,
      memoryMb: draft.memoryMb,
      replicas: draft.topology === 'single' ? 0 : draft.replicas,
      regions: parseRegionPlans(draft.regions),
      ...(draft.attachService ? { attachService: draft.attachService } : {}),
    });
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogTrigger asChild>
        <Button variant={variant}>
          <PlusIcon className="size-4" /> New cache
        </Button>
      </DialogTrigger>
      <DialogContent>
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle>It&apos;s provisioning.</DialogTitle>
              <DialogDescription>
                Save the password now — it lives only in the Docker secret{' '}
                <code className="mono-data">{result.passwordSecret}</code> and can&apos;t be shown
                again. Attached apps read it from the secret file automatically.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <div className="bg-muted/40 flex items-center justify-between gap-2 rounded-md px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <KeyRoundIcon className="text-muted-foreground size-4 shrink-0" />
                  <code className="mono-data truncate text-xs">{result.password}</code>
                </div>
                <CopyButton value={result.password} />
              </div>
              <div className="bg-muted/40 flex items-center justify-between gap-2 rounded-md px-3 py-2">
                <code className="mono-data truncate text-xs">
                  redis://{result.host}:{result.port}
                </code>
                <CopyButton value={`redis://${result.host}:${result.port}`} />
              </div>
            </div>
            <DialogFooter>
              <Button onClick={() => close(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>New managed cache</DialogTitle>
              <DialogDescription>
                Valkey or Redis on your own swarm — private by default, password in a Docker
                secret, no published ports.
              </DialogDescription>
            </DialogHeader>
            <CreateCacheFields draft={draft} onChange={setDraft} />
            <DialogFooter>
              <Button
                onClick={submit}
                disabled={provision.isPending || !draft.stack.trim() || !draft.name.trim()}
              >
                {provision.isPending ? 'Provisioning…' : 'Create cache'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
