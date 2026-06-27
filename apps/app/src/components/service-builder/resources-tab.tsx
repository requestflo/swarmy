import * as React from 'react';
import { Input, Label } from '@swarmy/ui';
import type { ModelResources, ServiceModelOut } from '@swarmy/core/compose';

interface ResourcesTabProps {
  model: ServiceModelOut;
  set: <K extends keyof ServiceModelOut>(key: K, value: ServiceModelOut[K]) => void;
}

const MIB = 1024 * 1024;

/** CPU/memory limits + reservations. CPU is fractional cores; memory in MiB. */
export function ResourcesTab({ model, set }: ResourcesTabProps): React.JSX.Element {
  const res = model.resources ?? {};

  const patch = (next: ModelResources): void => {
    const empty =
      !next.limits?.cpus &&
      !next.limits?.memoryBytes &&
      !next.reservations?.cpus &&
      !next.reservations?.memoryBytes;
    set('resources', empty ? undefined : next);
  };

  const bucket = (which: 'limits' | 'reservations'): React.JSX.Element => {
    const b = res[which] ?? {};
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label className="mono-label">CPUs</Label>
          <Input
            type="number"
            step="0.1"
            min={0}
            className="mono-data"
            placeholder="0.5"
            value={b.cpus ?? ''}
            onChange={(e) =>
              patch({ ...res, [which]: { ...b, cpus: e.target.value ? Number(e.target.value) : undefined } })
            }
          />
        </div>
        <div className="grid gap-1.5">
          <Label className="mono-label">Memory (MiB)</Label>
          <Input
            type="number"
            min={0}
            className="mono-data"
            placeholder="512"
            value={b.memoryBytes != null ? Math.round(b.memoryBytes / MIB) : ''}
            onChange={(e) =>
              patch({
                ...res,
                [which]: {
                  ...b,
                  memoryBytes: e.target.value ? Number(e.target.value) * MIB : undefined,
                },
              })
            }
          />
        </div>
      </div>
    );
  };

  return (
    <div className="grid gap-5">
      <div className="grid gap-2">
        <Label className="mono-label text-foreground">Limits</Label>
        <p className="text-muted-foreground text-xs">Hard ceiling — the task is throttled / OOM-killed past this.</p>
        {bucket('limits')}
      </div>
      <div className="grid gap-2">
        <Label className="mono-label text-foreground">Reservations</Label>
        <p className="text-muted-foreground text-xs">Guaranteed minimum the scheduler holds for the task.</p>
        {bucket('reservations')}
      </div>
    </div>
  );
}
