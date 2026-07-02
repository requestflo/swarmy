import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PlayIcon } from 'lucide-react';
// prettier-ignore
import {
  Button, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, toast,
} from '@swarmy/ui';
import type { DbBackupEngine } from '@swarmy/core/protocol';
import { useTRPC } from '@/integrations/trpc';
import { DB_BACKUP_ENGINES, isPhysical } from './db-backup-format';

interface DbBackupRunFormProps {
  stack: string;
  cluster: string;
  engine: DbBackupEngine;
  onEngine: (engine: DbBackupEngine) => void;
  targetId: string;
  onTargetId: (id: string) => void;
  dataVolume: string;
  onDataVolume: (volume: string) => void;
  targets: { id: string; name: string }[];
}

/** Engine + destination pickers and the one-off "Back up now" action. */
export function DbBackupRunForm({
  stack,
  cluster,
  engine,
  onEngine,
  targetId,
  onTargetId,
  dataVolume,
  onDataVolume,
  targets,
}: DbBackupRunFormProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const run = useMutation(
    trpc.dbBackups.run.mutationOptions({
      onSuccess: () => {
        toast.success(`Backing up ${cluster} (${engine})`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const meta = DB_BACKUP_ENGINES.find((e) => e.value === engine);
  const physical = isPhysical(engine);
  const submit = (): void =>
    run.mutate({
      stack,
      cluster,
      engine,
      targetId: targetId || undefined,
      dataVolume: dataVolume.trim() || undefined,
    });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label className="mono-label">Engine</Label>
          <Select value={engine} onValueChange={(v) => onEngine(v as DbBackupEngine)}>
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DB_BACKUP_ENGINES.map((e) => (
                <SelectItem key={e.value} value={e.value}>
                  {e.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label className="mono-label">Destination</Label>
          <Select value={targetId} onValueChange={onTargetId}>
            <SelectTrigger className="w-56">
              <SelectValue placeholder={targets.length ? 'Pick a destination' : 'No destinations yet'} />
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
        {physical && (
          <div className="grid gap-1.5">
            <Label htmlFor="db-bkp-volume" className="mono-label">
              PGDATA volume
            </Label>
            <Input
              id="db-bkp-volume"
              value={dataVolume}
              onChange={(e) => onDataVolume(e.target.value)}
              placeholder={`${stack}_${cluster}-primary-data`}
              className="w-64 font-mono text-sm"
            />
          </div>
        )}
        <Button
          onClick={submit}
          disabled={run.isPending || targets.length === 0 || (physical && !dataVolume.trim())}
        >
          <PlayIcon className="size-4" /> Back up now
        </Button>
      </div>
      {meta && <p className="text-muted-foreground text-sm">{meta.blurb}</p>}
    </div>
  );
}
