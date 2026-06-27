import * as React from 'react';
import {
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@swarmy/ui';
import type { ModelHealthcheck, ModelRestartPolicy, ServiceModelOut } from '@swarmy/core/compose';
import { ListEditor } from './list-editor';

interface HealthTabProps {
  model: ServiceModelOut;
  set: <K extends keyof ServiceModelOut>(key: K, value: ServiceModelOut[K]) => void;
}

const SEC = 1_000_000_000;

const secOf = (ns?: number): number | '' => (ns != null ? Math.round(ns / SEC) : '');
const nsOf = (s: string): number | undefined => (s ? Number(s) * SEC : undefined);

/** Healthcheck + restart policy + graceful shutdown. Durations shown in seconds. */
export function HealthTab({ model, set }: HealthTabProps): React.JSX.Element {
  const hc = model.healthcheck;
  const restart = model.restart ?? {};

  const patchHc = (next: Partial<ModelHealthcheck>): void => {
    const merged: ModelHealthcheck = { test: hc?.test ?? [], ...hc, ...next };
    const empty =
      merged.test.length === 0 &&
      merged.intervalNs == null &&
      merged.timeoutNs == null &&
      merged.startPeriodNs == null &&
      merged.retries == null &&
      !merged.disable;
    set('healthcheck', empty ? undefined : merged);
  };

  const patchRestart = (next: Partial<ModelRestartPolicy>): void => {
    const merged = { ...restart, ...next };
    const empty = merged.condition == null && merged.maxAttempts == null;
    set('restart', empty ? undefined : merged);
  };

  return (
    <div className="grid gap-6">
      <section className="grid gap-3">
        <Label className="mono-label text-foreground">Healthcheck</Label>
        <div className="grid gap-1.5">
          <Label className="mono-label">Test command</Label>
          <ListEditor
            value={hc?.test ?? []}
            onChange={(v) => patchHc({ test: v })}
            placeholder="CMD-SHELL"
            emptyHint="Inherits the image's HEALTHCHECK. First token is usually CMD or CMD-SHELL."
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <DurField label="Interval (s)" value={secOf(hc?.intervalNs)} onChange={(s) => patchHc({ intervalNs: nsOf(s) })} />
          <DurField label="Timeout (s)" value={secOf(hc?.timeoutNs)} onChange={(s) => patchHc({ timeoutNs: nsOf(s) })} />
          <DurField label="Start period (s)" value={secOf(hc?.startPeriodNs)} onChange={(s) => patchHc({ startPeriodNs: nsOf(s) })} />
          <div className="grid gap-1.5">
            <Label className="mono-label">Retries</Label>
            <Input
              type="number"
              min={0}
              className="mono-data"
              value={hc?.retries ?? ''}
              onChange={(e) => patchHc({ retries: e.target.value ? Number(e.target.value) : undefined })}
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Switch checked={hc?.disable ?? false} onCheckedChange={(v) => patchHc({ disable: v || undefined })} />
          <Label className="mono-label">Disable inherited healthcheck</Label>
        </div>
      </section>

      <section className="grid gap-3">
        <Label className="mono-label text-foreground">Restart policy</Label>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label className="mono-label">Condition</Label>
            <Select
              value={restart.condition ?? 'unset'}
              onValueChange={(v) => patchRestart({ condition: v === 'unset' ? undefined : (v as ModelRestartPolicy['condition']) })}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="unset">default (any)</SelectItem>
                <SelectItem value="none">none</SelectItem>
                <SelectItem value="on-failure">on-failure</SelectItem>
                <SelectItem value="any">any</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">Max attempts</Label>
            <Input
              type="number"
              min={0}
              className="mono-data"
              value={restart.maxAttempts ?? ''}
              onChange={(e) => patchRestart({ maxAttempts: e.target.value ? Number(e.target.value) : undefined })}
            />
          </div>
        </div>
      </section>

      <section className="grid gap-1.5">
        <Label className="mono-label text-foreground">Stop grace period (s)</Label>
        <Input
          type="number"
          min={0}
          className="mono-data w-40"
          value={secOf(model.stopGracePeriodNs)}
          onChange={(e) => set('stopGracePeriodNs', nsOf(e.target.value))}
        />
      </section>
    </div>
  );
}

function DurField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | '';
  onChange: (s: string) => void;
}): React.JSX.Element {
  return (
    <div className="grid gap-1.5">
      <Label className="mono-label">{label}</Label>
      <Input type="number" min={0} className="mono-data" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
