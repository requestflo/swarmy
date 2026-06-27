import * as React from 'react';
import { Input, Label } from '@swarmy/ui';
import type { ModelPlacement, ServiceModelOut } from '@swarmy/core/compose';
import { ListEditor } from './list-editor';

interface SchedulingTabProps {
  model: ServiceModelOut;
  set: <K extends keyof ServiceModelOut>(key: K, value: ServiceModelOut[K]) => void;
}

const EMPTY: ModelPlacement = { constraints: [], preferences: [] };

/** Swarm placement: constraints, preferences, max replicas per node. */
export function SchedulingTab({ model, set }: SchedulingTabProps): React.JSX.Element {
  const placement = model.placement ?? EMPTY;
  const patch = (p: Partial<ModelPlacement>): void => {
    const next = { ...placement, ...p };
    const empty =
      next.constraints.length === 0 &&
      next.preferences.length === 0 &&
      next.maxReplicasPerNode == null;
    set('placement', empty ? undefined : next);
  };

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Label className="mono-label">Constraints</Label>
        <ListEditor
          value={placement.constraints}
          onChange={(v) => patch({ constraints: v })}
          placeholder="node.role==worker"
          emptyHint="No constraints — scheduled swarm-wide."
        />
      </div>
      <div className="grid gap-2">
        <Label className="mono-label">Preferences</Label>
        <ListEditor
          value={placement.preferences}
          onChange={(v) => patch({ preferences: v })}
          placeholder="spread=node.labels.zone"
          emptyHint="No spread preferences."
        />
      </div>
      <div className="grid gap-1.5">
        <Label className="mono-label">Max replicas per node</Label>
        <Input
          type="number"
          min={1}
          className="mono-data w-40"
          value={placement.maxReplicasPerNode ?? ''}
          onChange={(e) =>
            patch({ maxReplicasPerNode: e.target.value ? Number(e.target.value) : undefined })
          }
        />
      </div>
    </div>
  );
}
