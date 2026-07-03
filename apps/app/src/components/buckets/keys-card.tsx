import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyIcon, PlusIcon, Trash2Icon } from 'lucide-react';
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
  EmptyState,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CreateKeyCard } from './create-key-card';
import { KeyRevealBanner, type RevealedKey } from './key-reveal-banner';

/** Org-wide access keys: list, mint (reveal-once), revoke. */
export function KeysCard(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [revealed, setRevealed] = React.useState<RevealedKey | null>(null);
  const keys = useQuery({ ...trpc.buckets.listKeys.queryOptions(), refetchInterval: 30_000 });

  const del = useMutation(
    trpc.buckets.deleteKey.mutationOptions({
      onSuccess: (r) => {
        toast.success(`Key ${r.accessKeyId} deleted`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const rows = keys.data?.keys ?? [];

  return (
    <section className="space-y-3">
      {revealed ? <KeyRevealBanner revealed={revealed} onDismiss={() => setRevealed(null)} /> : null}
      <div className="card-pop overflow-hidden">
        <div className="flex items-center justify-between border-b px-5 py-3">
          <div>
            <h2 className="font-medium">Access keys</h2>
            <p className="text-muted-foreground text-xs">
              S3 credentials for tools and CI. Secrets are shown once at creation, never again.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setCreateOpen((o) => !o)}>
            <PlusIcon className="size-4" /> New key
          </Button>
        </div>
        <CreateKeyCard
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={(r) => {
            setRevealed(r);
            setCreateOpen(false);
          }}
        />
        {keys.isLoading ? (
          <div className="space-y-2 p-5">
            <div className="shimmer-line h-6 rounded" />
            <div className="shimmer-line h-6 w-2/3 rounded" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            className="m-3 py-10"
            icon={<KeyIcon />}
            title="No access keys yet."
            description="Mint a key for CLI tools or CI, then grant it read/write on the buckets it needs."
          />
        ) : (
          <ul className="divide-border divide-y">
            {rows.map((k) => (
              <li key={k.id} className="flex items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{k.name || 'unnamed key'}</p>
                  <p className="mono-data text-muted-foreground truncate text-xs">{k.id}</p>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon"
                      className="text-status-offline shrink-0"
                      aria-label={`Delete key ${k.name || k.id}`}
                      disabled={del.isPending}
                    >
                      <Trash2Icon className="size-4" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete key "{k.name || k.id}"?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Apps and tools using this key lose access immediately. There is no undo.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Keep it</AlertDialogCancel>
                      <AlertDialogAction onClick={() => del.mutate({ accessKeyId: k.id })}>
                        Delete key
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
