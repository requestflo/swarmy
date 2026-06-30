import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RotateCcwIcon } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@swarmy/ui';
import { DbRestoreFields } from './db-restore-fields';
import {
  useDbMutation,
  type DbBackupView,
  type DbRestoreMode,
} from './managed-db-trpc';

interface RestoreInput {
  stack: string;
  cluster: string;
  backupId: string;
  mode: DbRestoreMode;
  targetCluster?: string;
  pitrTarget?: string;
  database?: string;
}

const MODES: { value: DbRestoreMode; label: string; blurb: string }[] = [
  { value: 'clone', label: 'Clone to new cluster', blurb: 'Restore into a fresh cluster — safest, nothing live is touched.' },
  { value: 'pitr', label: 'Point-in-time', blurb: 'Replay WAL up to a timestamp (pgBackRest).' },
  { value: 'in-place', label: 'In place', blurb: 'Overwrite the live primary — destructive.' },
  { value: 'single-db', label: 'Single database', blurb: 'Restore just one database from the backup.' },
];

/** Restore a single DB backup from the canvas, with a mode-specific form. */
export function DbRestoreDialog({
  stack,
  cluster,
  backup,
}: {
  stack: string;
  cluster: string;
  backup: DbBackupView;
}): React.JSX.Element {
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [mode, setMode] = React.useState<DbRestoreMode>('clone');
  const [targetCluster, setTargetCluster] = React.useState(`${cluster}-restore`);
  const [pitrTarget, setPitrTarget] = React.useState('');
  const [database, setDatabase] = React.useState('app');

  const restore = useDbMutation<{ operationId: string }, RestoreInput>('dbBackup', 'restore', {
    onSuccess: () => {
      toast.success(`Restore started from ${backup.engine} backup`);
      setOpen(false);
      void qc.invalidateQueries();
    },
    onError: (e) => toast.error(e.message),
  });

  const meta = MODES.find((m) => m.value === mode);
  const submit = (): void =>
    restore.mutate({
      stack,
      cluster,
      backupId: backup.id,
      mode,
      targetCluster: mode === 'clone' || mode === 'pitr' ? targetCluster.trim() || undefined : undefined,
      pitrTarget: mode === 'pitr' ? pitrTarget.trim() || undefined : undefined,
      database: mode === 'single-db' ? database.trim() || undefined : undefined,
    });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="rounded-full">
          <RotateCcwIcon className="size-4" /> Restore
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Restore backup</DialogTitle>
          <DialogDescription>
            {backup.engine} · {new Date(backup.startedAt).toLocaleString()}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-1.5">
            <Label className="mono-label">Mode</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as DbRestoreMode)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODES.map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {meta && <p className="text-muted-foreground text-sm">{meta.blurb}</p>}
          </div>

          <DbRestoreFields
            mode={mode}
            cluster={cluster}
            targetCluster={targetCluster}
            onTargetCluster={setTargetCluster}
            pitrTarget={pitrTarget}
            onPitrTarget={setPitrTarget}
            database={database}
            onDatabase={setDatabase}
          />
        </div>

        <DialogFooter>
          <Button
            variant={mode === 'in-place' ? 'destructive' : 'default'}
            onClick={submit}
            disabled={restore.isPending}
          >
            <RotateCcwIcon className="size-4" /> Start restore
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
