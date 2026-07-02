import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { JobKind } from '@swarmy/core';
import {
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import type { JobDraft } from './job-draft';
import { ScheduleField } from './schedule-field';

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

/** Core job fields: name, schedule, what to run and its env. */
export function JobFormFields({
  draft,
  onChange,
  nameLocked,
}: {
  draft: JobDraft;
  onChange: (next: JobDraft) => void;
  nameLocked?: boolean;
}): React.JSX.Element {
  const trpc = useTRPC();
  const services = useQuery({
    ...trpc.services.list.queryOptions({}),
    enabled: draft.kind === 'service-exec',
  });
  const set = (patch: Partial<JobDraft>): void => onChange({ ...draft, ...patch });

  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name">
          <Input
            value={draft.name}
            disabled={nameLocked}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="nightly-report"
          />
        </Field>
        <Field label="Runs as">
          <Select value={draft.kind} onValueChange={(v) => set({ kind: v as JobKind })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="image">One-shot container (image)</SelectItem>
              <SelectItem value="service-exec">Exec in a running service</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>

      <ScheduleField value={draft.schedule} onChange={(schedule) => set({ schedule })} />

      {draft.kind === 'image' ? (
        <Field label="Image">
          <Input
            value={draft.image}
            onChange={(e) => set({ image: e.target.value })}
            placeholder="alpine:3"
            className="font-mono"
          />
        </Field>
      ) : (
        <Field label="Service">
          <Select value={draft.serviceRef || undefined} onValueChange={(v) => set({ serviceRef: v })}>
            <SelectTrigger>
              <SelectValue placeholder="Pick the service to exec into" />
            </SelectTrigger>
            <SelectContent>
              {(services.data ?? []).map((s: { id: string; name: string }) => (
                <SelectItem key={s.id} value={s.name}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}

      <Field label="Command">
        <Input
          value={draft.command}
          onChange={(e) => set({ command: e.target.value })}
          placeholder={draft.kind === 'image' ? 'node dist/report.js' : 'php artisan queue:prune'}
          className="font-mono"
        />
      </Field>
      <p className="text-muted-foreground -mt-2 text-xs">Runs via `sh -c` inside the container.</p>

      <Field label="Environment (KEY=VALUE per line, optional)">
        <Textarea
          value={draft.env}
          onChange={(e) => set({ env: e.target.value })}
          placeholder={'REPORT_DAY=yesterday\nLOG_LEVEL=info'}
          className="min-h-16 font-mono text-xs"
        />
      </Field>
    </div>
  );
}
