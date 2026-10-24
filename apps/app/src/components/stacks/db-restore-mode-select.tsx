import * as React from 'react';
import { Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@swarmy/ui';
import type { DbBackupEngine, DbRestoreMode } from '@swarmy/core/protocol';
import { DB_RESTORE_MODES, engineLabel, isPhysical } from './db-backup-format';

/** The restore dialog's mode picker, with what the mode does (and why PITR can't run on a logical save). */
export function DbRestoreModeSelect({
  mode,
  onMode,
  engine,
}: {
  mode: DbRestoreMode;
  onMode: (m: DbRestoreMode) => void;
  engine: DbBackupEngine;
}): React.JSX.Element {
  const meta = DB_RESTORE_MODES.find((m) => m.value === mode);
  return (
    <div className="grid gap-1.5">
      <Label className="mono-label">Mode</Label>
      <Select value={mode} onValueChange={(v) => onMode(v as DbRestoreMode)}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {DB_RESTORE_MODES.map((m) => (
            <SelectItem key={m.value} value={m.value}>
              {m.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {meta && <p className="text-muted-foreground text-sm">{meta.blurb}</p>}
      {mode === 'pitr' && !isPhysical(engine) && (
        <p className="text-tone-warn text-sm">
          Point-in-time needs a wal-g / pgBackRest backup — this one is {engineLabel(engine)}.
        </p>
      )}
    </div>
  );
}
