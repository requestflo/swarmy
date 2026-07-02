import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { QUEUE_CONVENTIONS, type QueueConvention } from '@swarmy/core';
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
import { useTRPC } from '@/integrations/trpc';

export interface QueueDraft {
  workerService: string;
  name: string;
  /** `<stack>/<cluster>` as picked from the cache list. */
  cacheCluster: string;
  convention: QueueConvention;
  listKey: string;
  scalePerJobs: number;
  minWorkers: number;
  maxWorkers: number;
  retries: number;
  dlq: boolean;
}

export const EMPTY_QUEUE_DRAFT: QueueDraft = {
  workerService: '',
  name: '',
  cacheCluster: '',
  convention: 'bullmq',
  listKey: '',
  scalePerJobs: 100,
  minWorkers: 1,
  maxWorkers: 5,
  retries: 3,
  dlq: true,
};

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="grid gap-1.5">
      <Label className="mono-label">{label}</Label>
      {children}
    </div>
  );
}

/** Attach-queue wizard fields: worker + cache + convention + scale rules. */
export function AttachQueueFields({
  draft,
  onChange,
}: {
  draft: QueueDraft;
  onChange: (next: QueueDraft) => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const services = useQuery(trpc.services.list.queryOptions({}));
  const caches = useQuery(trpc.cache.list.queryOptions());
  const set = (patch: Partial<QueueDraft>): void => onChange({ ...draft, ...patch });
  const num = (v: string, min: number): number => Math.max(min, Number(v) || 0);

  return (
    <div className="grid gap-3">
      <Field label="Worker service">
        <Select value={draft.workerService || undefined} onValueChange={(v) => set({ workerService: v })}>
          <SelectTrigger><SelectValue placeholder="Which service consumes the jobs?" /></SelectTrigger>
          <SelectContent>
            {(services.data ?? []).map((s) => (
              <SelectItem key={s.id} value={s.name}>{s.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Cache cluster">
        <Select value={draft.cacheCluster || undefined} onValueChange={(v) => set({ cacheCluster: v })}>
          <SelectTrigger><SelectValue placeholder="Which cache holds the queue?" /></SelectTrigger>
          <SelectContent>
            {(caches.data ?? []).map((c) => (
              <SelectItem key={`${c.stack}/${c.name}`} value={`${c.stack}/${c.name}`}>
                {c.stack}/{c.name} · {c.engine}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Queue name">
          <Input value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="emails" />
        </Field>
        <Field label="Convention">
          <Select value={draft.convention} onValueChange={(v) => set({ convention: v as QueueConvention })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {QUEUE_CONVENTIONS.map((c) => (
                <SelectItem key={c} value={c}>{c === 'bullmq' ? 'BullMQ' : 'Raw list'}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      {draft.convention === 'list' ? (
        <Field label="List key">
          <Input
            value={draft.listKey}
            onChange={(e) => set({ listKey: e.target.value })}
            placeholder={draft.name || 'jobs'}
          />
        </Field>
      ) : null}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Jobs / worker">
          <Input type="number" min={1} value={draft.scalePerJobs} onChange={(e) => set({ scalePerJobs: num(e.target.value, 1) })} />
        </Field>
        <Field label="Min workers">
          <Input type="number" min={0} value={draft.minWorkers} onChange={(e) => set({ minWorkers: num(e.target.value, 0) })} />
        </Field>
        <Field label="Max workers">
          <Input type="number" min={1} value={draft.maxWorkers} onChange={(e) => set({ maxWorkers: num(e.target.value, 1) })} />
        </Field>
        <Field label="Retries">
          <Input type="number" min={0} value={draft.retries} onChange={(e) => set({ retries: num(e.target.value, 0) })} />
        </Field>
      </div>
      <p className="text-muted-foreground -mt-1 text-xs">
        Workers autoscale: one replica per {draft.scalePerJobs || '…'} waiting jobs, held between{' '}
        {draft.minWorkers} and {draft.maxWorkers}.
      </p>
      <div className="flex items-center justify-between gap-3">
        <div>
          <Label className="mono-label">Dead-letter queue</Label>
          <p className="text-muted-foreground text-xs">
            Browse and requeue exhausted jobs from <code className="mono-data">{draft.name || '<queue>'}:dead</code>.
          </p>
        </div>
        <Switch checked={draft.dlq} onCheckedChange={(v) => set({ dlq: v })} />
      </div>
    </div>
  );
}
