import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RotateCcwIcon } from 'lucide-react';
import {
  AlertDialog,
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
  cn,
  toast,
} from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { fmtBytes } from './backup-format';

interface RestoreSnapshotConfirmProps {
  snapshotId: string;
  volume: string;
  disabled?: boolean;
}

function copyName(volume: string): string {
  const d = new Date();
  return `${volume}-restore-${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Restore — two ways, the safe one first: into a new copy next to the live
 * one (nothing changes until you swap), or replace the live volume.
 */
export function RestoreSnapshotConfirm({ snapshotId, volume, disabled }: RestoreSnapshotConfirmProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [mode, setMode] = React.useState<'copy' | 'replace'>('copy');
  const [name, setName] = React.useState(() => copyName(volume));

  const restore = useMutation(
    trpc.backups.restoreSnapshot.mutationOptions({
      onSuccess: (r) => {
        setOpen(false);
        toast.success(`Restored ${volume} → ${r.targetVolume}`, {
          description: `${fmtBytes(r.bytesRestored)} written from snapshot ${snapshotId.slice(0, 8)}.`,
          duration: 8_000,
        });
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(`Restore of ${volume} failed`, { description: e.message, duration: 10_000 }),
    }),
  );
  const choice = (m: 'copy' | 'replace', title: string, body: string, tag?: string): React.JSX.Element => (
    <button
      type="button"
      role="radio"
      aria-checked={mode === m}
      onClick={() => setMode(m)}
      className={cn('rounded-xl border p-3 text-left', mode === m ? 'border-primary shadow-[inset_0_0_0_1px_var(--primary)]' : 'hover:bg-accent')}
    >
      <span className="flex items-center gap-2 text-sm font-semibold">
        {title}
        {tag ? <span className="text-tone-ok text-xs font-medium">{tag}</span> : null}
      </span>
      <span className="text-muted-foreground mt-1 block text-xs">{body}</span>
    </button>
  );

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" className="shrink-0 pointer-coarse:min-h-11" disabled={disabled}>
          <RotateCcwIcon className="size-4" /> Restore…
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Restore {volume}</AlertDialogTitle>
          <AlertDialogDescription>Nothing changes until you press Restore.</AlertDialogDescription>
        </AlertDialogHeader>
        <div role="radiogroup" aria-label="How to restore" className="grid gap-2">
          {choice('copy', 'Into a new copy', 'The app keeps running. You get a copy next to it to look inside, then swap it in.', 'recommended')}
          {choice('replace', 'Replace the live one', 'Overwrites the live volume with this save. Stop the app first for a clean result.')}
        </div>
        {mode === 'copy' ? (
          <div className="grid gap-1.5">
            <Label htmlFor={`restore-${snapshotId}`}>New volume name</Label>
            <Input id={`restore-${snapshotId}`} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        ) : null}
        <Tech>backups.restoreSnapshot · snapshot {snapshotId.slice(0, 8)} → {mode === 'copy' ? name : volume}</Tech>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            variant={mode === 'replace' ? 'destructive' : 'default'}
            disabled={restore.isPending || (mode === 'copy' && !name.trim())}
            onClick={() => restore.mutate({ snapshotId, targetVolume: mode === 'copy' ? name.trim() : undefined })}
          >
            {restore.isPending ? 'Restoring…' : mode === 'copy' ? 'Restore into a new copy' : 'Replace the live volume'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
