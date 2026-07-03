import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { Field } from './field';
import type { TargetOption } from './target-option';

interface BackupVolumeInlineProps {
  stack: string;
  targets: TargetOption[];
  onDone: () => void;
}

/** Ad-hoc volume backup — expands inside the snapshots card, never a modal. */
export function BackupVolumeInline({
  stack,
  targets,
  onDone,
}: BackupVolumeInlineProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [volume, setVolume] = React.useState(`${stack}_`);
  const [targetId, setTargetId] = React.useState(targets[0]?.id ?? '');

  const run = useMutation(
    trpc.backups.backupVolume.mutationOptions({
      onSuccess: () => {
        toast.success('Backup finished — snapshot in the catalog');
        setVolume(`${stack}_`);
        onDone();
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <div className="bg-accent/40 grid gap-3 border-t px-6 py-5 sm:grid-cols-[1fr_1fr_auto]">
      <Field label="Docker volume">
        <Input
          value={volume}
          onChange={(e) => setVolume(e.target.value)}
          placeholder={`${stack}_postgres-data`}
        />
      </Field>
      <Field label="Destination">
        <Select value={targetId} onValueChange={setTargetId}>
          <SelectTrigger>
            <SelectValue placeholder="Pick a destination" />
          </SelectTrigger>
          <SelectContent>
            {targets.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <div className="flex items-end">
        <Button
          size="sm"
          variant="outline"
          className="rounded-full font-bold"
          disabled={run.isPending || !targetId || volume.trim() === `${stack}_`}
          onClick={() => run.mutate({ volume: volume.trim(), targetId })}
        >
          {run.isPending ? 'Backing up…' : 'Back up now'}
        </Button>
      </div>
    </div>
  );
}
