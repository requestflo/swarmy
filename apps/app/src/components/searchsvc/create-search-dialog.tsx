import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRoundIcon, PlusIcon } from 'lucide-react';
import type { SearchProvisionResult } from '@swarmy/core';
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
import { CreateSearchFields, EMPTY_SEARCH_DRAFT, type SearchDraft } from './create-search-fields';

/**
 * Create-search wizard. On success it shows the generated master key ONCE —
 * swarmy stores it only as a Docker secret and can never show it again.
 */
export function CreateSearchDialog({
  variant = 'default',
}: {
  variant?: ButtonProps['variant'];
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<SearchDraft>(EMPTY_SEARCH_DRAFT);
  const [result, setResult] = React.useState<SearchProvisionResult | null>(null);

  const provision = useMutation(
    trpc.search.provision.mutationOptions({
      onSuccess: (r) => {
        setResult(r);
        toast.success(`Search instance ${r.name} is provisioning`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const close = (next: boolean): void => {
    setOpen(next);
    if (!next) {
      setDraft(EMPTY_SEARCH_DRAFT);
      setResult(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogTrigger asChild>
        <Button variant={variant}>
          <PlusIcon className="size-4" /> New search instance
        </Button>
      </DialogTrigger>
      <DialogContent>
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle>It&apos;s provisioning.</DialogTitle>
              <DialogDescription>
                Save the master key now — it lives only in the Docker secret{' '}
                <code className="mono-data">{result.keySecret}</code> and can&apos;t be shown
                again. Attached apps read it from the secret file automatically.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <div className="bg-muted/40 flex items-center justify-between gap-2 rounded-md px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <KeyRoundIcon className="text-muted-foreground size-4 shrink-0" />
                  <code className="mono-data truncate text-xs">{result.masterKey}</code>
                </div>
                <CopyButton value={result.masterKey} />
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
              <DialogTitle>New managed search</DialogTitle>
              <DialogDescription>
                Meilisearch or Typesense on your own swarm — private by default, master key in a
                Docker secret, no published ports.
              </DialogDescription>
            </DialogHeader>
            <CreateSearchFields draft={draft} onChange={setDraft} />
            <DialogFooter>
              <Button
                onClick={() =>
                  provision.mutate({
                    stack: draft.stack.trim(),
                    name: draft.name.trim(),
                    engine: draft.engine,
                    ...(draft.attachService ? { attachService: draft.attachService } : {}),
                  })
                }
                disabled={provision.isPending || !draft.stack.trim() || !draft.name.trim()}
              >
                {provision.isPending ? 'Provisioning…' : 'Create search'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
