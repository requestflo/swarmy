import * as React from 'react';
import { Input, Label, Switch } from '@swarmy/ui';
import type { JobDraft } from './job-draft';

/** Timeout / retries / alerting / placement — sane defaults, rarely touched. */
export function JobFormAdvanced({
  draft,
  onChange,
}: {
  draft: JobDraft;
  onChange: (next: JobDraft) => void;
}): React.JSX.Element {
  const set = (patch: Partial<JobDraft>): void => onChange({ ...draft, ...patch });

  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-1.5">
          <Label>Timeout (minutes)</Label>
          <Input
            type="number"
            min={1}
            max={1440}
            value={draft.timeoutMin}
            onChange={(e) => set({ timeoutMin: Math.max(1, Number(e.target.value) || 1) })}
          />
        </div>
        <div className="grid gap-1.5">
          <Label>Retries</Label>
          <Input
            type="number"
            min={0}
            max={5}
            value={draft.retries}
            onChange={(e) => set({ retries: Math.min(5, Math.max(0, Number(e.target.value) || 0)) })}
          />
        </div>
      </div>

      {draft.kind === 'image' ? (
        <div className="grid gap-1.5">
          <Label>Run on nodes labelled (optional)</Label>
          <Input
            value={draft.runOnLabels}
            onChange={(e) => set({ runOnLabels: e.target.value })}
            placeholder="gpu=true, region=eu"
            className="font-mono"
          />
        </div>
      ) : null}

      <div className="flex items-center justify-between rounded-md border px-3 py-2">
        <div>
          <p className="text-sm font-medium">Alert on failure</p>
          <p className="text-muted-foreground text-xs">
            Raise an alert event when the final attempt fails or times out.
          </p>
        </div>
        <Switch
          checked={draft.alertOnFailure}
          onCheckedChange={(alertOnFailure) => set({ alertOnFailure })}
        />
      </div>
    </div>
  );
}
