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
  toast,
} from '@swarmy/ui';
import type { DbBackupSnapshotView } from '@swarmy/core';
import type { DbRestoreMode } from '@swarmy/core/protocol';
import { useTRPC } from '@/integrations/trpc';
import { RestoreCopyStatus } from '@/components/backups/restore-copy-status';
import { useRestoreCopy } from '@/components/backups/use-restore-copy';
import { DbRestoreFields } from './db-restore-fields';
import { DbRestoreModeSelect } from './db-restore-mode-select';
import { engineLabel, isPhysical } from './db-backup-format';

/**
 * Restore a single DB backup — a destructive confirm with a mode-specific
 * form, so it uses the one sanctioned modal (AlertDialog) around
 * `DbRestoreFields`. A clone creates its own database (`useRestoreCopy`)
 * and stays open on what it made, with "Remove the copy".
 */
export function DbRestoreDialog({
  stack,
  cluster,
  targetId,
  backup,
  initialMode,
  initialTargetTime,
  trigger,
}: {
  stack: string;
  cluster: string;
  /** Destination the backup was listed from; defaults server-side when omitted. */
  targetId?: string;
  backup: DbBackupSnapshotView;
  /** The mode it opens on (Time travel's copy / replace choice); defaults to a clone. */
  initialMode?: DbRestoreMode;
  /** Point-in-time: the moment to recover to (ISO), prefilled. */
  initialTargetTime?: string;
  /** Custom trigger; defaults to the quiet "Restore" button. */
  trigger?: React.ReactElement;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [mode, setMode] = React.useState<DbRestoreMode>(initialMode ?? 'clone-to-new-cluster');
  const [pitrTarget, setPitrTarget] = React.useState(initialTargetTime ?? '');
  const [database, setDatabase] = React.useState('app');
  const [dataVolume, setDataVolume] = React.useState('');

  const engine = backup.engine ?? 'pg_dump';
  const copy = useRestoreCopy(stack, cluster);
  const clone = mode === 'clone-to-new-cluster';
  const made = clone && copy.restore.isSuccess;

  const restore = useMutation(
    trpc.dbBackups.restore.mutationOptions({
      onSuccess: () => {
        toast.success(`Restore started from ${engineLabel(engine)} backup`);
        setOpen(false);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const pitrBlocked = mode === 'pitr' && (!isPhysical(engine) || !dataVolume.trim());
  const pending = restore.isPending || copy.running != null;
  const submit = (): void =>
    clone
      ? copy.restore.mutate({ stack, cluster, engine, targetId, snapshotId: backup.id, name: copy.name })
      : restore.mutate({
          stack,
          cluster,
          engine,
          mode,
          targetId,
          snapshotId: backup.id,
          targetTime: mode === 'pitr' ? pitrTarget.trim() || undefined : undefined,
          database: mode === 'single-database' ? database.trim() || undefined : undefined,
          dataVolume: mode === 'pitr' ? dataVolume.trim() || undefined : undefined,
        });

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        {trigger ?? (
          <Button variant="outline" size="sm" className="rounded-full">
            <RotateCcwIcon className="size-4" /> Restore
          </Button>
        )}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Restore backup</AlertDialogTitle>
          <AlertDialogDescription>
            {engineLabel(backup.engine)} · {new Date(backup.time).toLocaleString()}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-4">
          {made ? null : <DbRestoreModeSelect mode={mode} onMode={setMode} engine={engine} />}

          {made ? null : <DbRestoreFields
            mode={mode}
            stack={stack}
            cluster={cluster}
            copyName={copy.name}
            pitrTarget={pitrTarget}
            onPitrTarget={setPitrTarget}
            database={database}
            onDatabase={setDatabase}
            dataVolume={dataVolume}
            onDataVolume={setDataVolume}
          />}
          {/* This dialog's own copy restore: running, then what it made. */}
          {clone && (copy.restore.isPending || made) ? <RestoreCopyStatus stack={stack} cluster={cluster} copy={copy} /> : null}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel>{made ? 'Done' : 'Cancel'}</AlertDialogCancel>
          {made ? null : (
            <Button
              variant={mode === 'in-place' ? 'destructive' : 'default'}
              onClick={submit}
              disabled={pending || pitrBlocked || (clone && !copy.ready)}
            >
              <RotateCcwIcon className="size-4" />
              {pending ? 'Restoring…' : 'Start restore'}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
