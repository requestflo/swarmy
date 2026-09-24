import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RotateCcwIcon } from 'lucide-react';
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

interface RestoreAppDbConfirmProps {
  stack: string;
  service: string;
  engine: string;
  snapshotId: string;
  disabled?: boolean;
}

const KV = new Set(['redis', 'valkey']);

/**
 * Restore a logical dump — the sanctioned modal. Defaults to a copy (renamed
 * databases in the same server; a new volume for Redis/Valkey). In place
 * replaces the live data, so it takes a safety dump first and demands the
 * service name typed back.
 */
export function RestoreAppDbConfirm({
  stack,
  service,
  engine,
  snapshotId,
  disabled,
}: RestoreAppDbConfirmProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [mode, setMode] = React.useState<'copy' | 'in-place'>('copy');
  const [confirm, setConfirm] = React.useState('');
  const kv = KV.has(engine);

  const restore = useMutation(
    trpc.backups.appDb.restore.mutationOptions({
      onSuccess: (r) => {
        setOpen(false);
        setConfirm('');
        setMode('copy');
        const where =
          r.mode === 'copy'
            ? r.volume
              ? `into the new volume ${r.volume}`
              : `into ${r.databases.join(', ') || 'a copy'}`
            : `in place${r.safetySnapshotId ? ` — safety dump ${r.safetySnapshotId.slice(0, 8)} was taken first` : ''}`;
        toast.success(`Restored ${service} ${where}`, { duration: 10_000 });
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(`Restore of ${service} failed`, { description: e.message, duration: 12_000 }),
    }),
  );

  const confirmed = mode === 'copy' || confirm.trim() === service;

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" className="rounded-full" disabled={disabled}>
          <RotateCcwIcon className="size-4" /> Restore
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Restore {service} from dump {snapshotId.slice(0, 8)}?</AlertDialogTitle>
          <AlertDialogDescription>
            {mode === 'copy'
              ? kv
                ? 'The dump is written into a new volume next to the live one. Nothing the app uses changes.'
                : 'The dump is loaded into new, renamed databases in the same server (e.g. app → app_copy_…). Nothing the app uses changes.'
              : kv
                ? `${service} is stopped, its data file is replaced with the dump, and it is started again. A safety dump is taken first.`
                : `The dumped databases in ${service} are dropped and recreated from the dump. A safety dump is taken first so you can undo it.`}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            className="rounded-full"
            variant={mode === 'copy' ? 'default' : 'outline'}
            onClick={() => setMode('copy')}
          >
            Restore as a copy
          </Button>
          <Button
            size="sm"
            className="rounded-full"
            variant={mode === 'in-place' ? 'destructive' : 'outline'}
            onClick={() => setMode('in-place')}
          >
            Replace live data
          </Button>
        </div>

        {mode === 'in-place' && (
          <div className="grid gap-1.5">
            <Label className="mono-label" htmlFor={`appdb-confirm-${snapshotId}`}>
              Type <span className="text-foreground">{service}</span> to confirm
            </Label>
            <Input
              id={`appdb-confirm-${snapshotId}`}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder={service}
              autoComplete="off"
            />
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={restore.isPending || !confirmed}
            onClick={(e) => {
              e.preventDefault();
              restore.mutate({
                stack,
                service,
                snapshotId,
                mode,
                ...(mode === 'in-place' ? { confirm: confirm.trim() } : {}),
              });
            }}
          >
            {restore.isPending ? 'Restoring…' : mode === 'copy' ? 'Restore as a copy' : 'Replace live data'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
