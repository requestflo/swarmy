import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DatabaseBackupIcon } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

export function BackupVolumeDialog({
  targets,
}: {
  targets: { id: string; name: string; enabled: boolean }[];
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [volume, setVolume] = React.useState('');
  const [targetId, setTargetId] = React.useState('');

  const run = useMutation(
    trpc.backups.backupVolume.mutationOptions({
      onSuccess: () => {
        toast.success('Backup started');
        setOpen(false);
        setVolume('');
        qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" disabled={targets.length === 0}>
          <DatabaseBackupIcon className="size-4" /> Back up a volume
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Back up a volume</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label className="mono-label">Docker volume name</Label>
            <Input value={volume} onChange={(e) => setVolume(e.target.value)} placeholder="postgres_data" />
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">Target</Label>
            <Select value={targetId} onValueChange={setTargetId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a target" />
              </SelectTrigger>
              <SelectContent>
                {targets.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={run.isPending || !volume || !targetId}
            onClick={() => run.mutate({ volume, targetId })}
          >
            {run.isPending ? 'Backing up…' : 'Back up now'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
