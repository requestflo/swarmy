import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CloudDownloadIcon } from 'lucide-react';
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

interface RestoreOffsiteConfirmProps {
  targetName: string;
  disabled?: boolean;
}

/**
 * "Restore from offsite" — the sanctioned modal for a destructive, estate-wide
 * action. Previews the buckets found off-site, then demands the destination's
 * name typed back before copying everything into the object store.
 */
export function RestoreOffsiteConfirm({
  targetName,
  disabled,
}: RestoreOffsiteConfirmProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [confirm, setConfirm] = React.useState('');

  const preview = useQuery({
    ...trpc.offsiteMirror.offsiteBuckets.queryOptions(),
    enabled: open,
    retry: false,
  });

  const restore = useMutation(
    trpc.offsiteMirror.restore.mutationOptions({
      onSuccess: (r) => {
        setOpen(false);
        setConfirm('');
        toast.success(`Restoring ${r.buckets.length} bucket${r.buckets.length === 1 ? '' : 's'}`, {
          description: 'Copying back from off-site — follow it on the Offsite mirror card.',
          duration: 8_000,
        });
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error('Restore refused', { description: e.message, duration: 10_000 }),
    }),
  );

  const found = preview.data?.buckets ?? [];

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="ghost" className="rounded-full" disabled={disabled}>
          <CloudDownloadIcon className="size-4" /> Restore from offsite
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Restore object storage from {targetName}?</AlertDialogTitle>
          <AlertDialogDescription>
            Every bucket in the off-site copy is copied back into swarmy's object store — missing
            buckets are recreated, objects that differ are overwritten with the off-site version.
            Nothing is deleted. Use it after losing the cluster.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="bg-accent/50 rounded-xl px-4 py-3">
          <p className="mono-label text-muted-foreground mb-2">
            Off-site {preview.data?.root ? `· ${preview.data.root}` : ''}
          </p>
          {preview.isLoading ? (
            <span className="shimmer-line block h-4 w-40 rounded" />
          ) : preview.error ? (
            <p className="text-status-offline text-sm">{preview.error.message}</p>
          ) : found.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing off-site yet.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {found.map((b) => (
                <span key={b} className="mono-data bg-card rounded-full border px-2.5 py-1 text-xs">
                  {b}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="grid gap-1.5">
          <Label className="mono-label" htmlFor="restore-offsite-confirm">
            Type <span className="text-foreground">{targetName}</span> to confirm
          </Label>
          <Input
            id="restore-offsite-confirm"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder={targetName}
            autoComplete="off"
          />
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={restore.isPending || confirm.trim() !== targetName || found.length === 0}
            onClick={(e) => {
              e.preventDefault();
              restore.mutate({ confirm: confirm.trim() });
            }}
          >
            {restore.isPending ? 'Starting…' : 'Restore from offsite'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
