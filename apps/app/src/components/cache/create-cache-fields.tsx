import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { CACHE_ENGINES, CACHE_TOPOLOGIES, type CacheEngine, type CacheTopology } from '@swarmy/core';
import {
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CacheRegionField } from './cache-region-field';

export interface CacheDraft {
  stack: string;
  name: string;
  engine: CacheEngine;
  topology: CacheTopology;
  memoryMb: number;
  replicas: number;
  /** Free-form `region=replicas, …` plan (parsed by parseRegionPlans). */
  regions: string;
  attachService: string;
}

export const EMPTY_DRAFT: CacheDraft = {
  stack: '',
  name: 'main',
  engine: 'valkey',
  topology: 'single',
  memoryMb: 256,
  replicas: 1,
  regions: '',
  attachService: '',
};

const MEMORY_CHOICES = [128, 256, 512, 1024, 2048, 4096];
const TOPOLOGY_HELP: Record<CacheTopology, string> = {
  single: 'One server — simplest, no failover.',
  replica: 'Primary + read replicas (async).',
  sentinel: 'HA: 3 sentinels fail over automatically.',
};

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="grid gap-1.5">
      <Label className="mono-label">{label}</Label>
      {children}
    </div>
  );
}

/** The create-cache fields (engine / mode / memory / replicas / attach). */
export function CreateCacheFields({
  draft,
  onChange,
  hideStack = false,
}: {
  draft: CacheDraft;
  onChange: (next: CacheDraft) => void;
  /** Hide the stack input when the stack comes from the workspace route. */
  hideStack?: boolean;
}): React.JSX.Element {
  const trpc = useTRPC();
  const services = useQuery(trpc.services.list.queryOptions({}));
  const set = (patch: Partial<CacheDraft>): void => onChange({ ...draft, ...patch });

  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-3">
        {hideStack ? null : (
          <Field label="Stack">
            <Input value={draft.stack} onChange={(e) => set({ stack: e.target.value })} placeholder="shop" />
          </Field>
        )}
        <Field label="Cache name">
          <Input value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="main" />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Engine">
          <Select value={draft.engine} onValueChange={(v) => set({ engine: v as CacheEngine })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {CACHE_ENGINES.map((e) => (
                <SelectItem key={e} value={e}>{e === 'valkey' ? 'Valkey (default)' : 'Redis'}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Mode">
          <Select value={draft.topology} onValueChange={(v) => set({ topology: v as CacheTopology })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {CACHE_TOPOLOGIES.map((t) => (
                <SelectItem key={t} value={t}>{t === 'sentinel' ? 'HA (sentinel)' : t}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <p className="text-muted-foreground -mt-1 text-xs">{TOPOLOGY_HELP[draft.topology]}</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Memory">
          <Select value={String(draft.memoryMb)} onValueChange={(v) => set({ memoryMb: Number(v) })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {MEMORY_CHOICES.map((m) => (
                <SelectItem key={m} value={String(m)}>{m >= 1024 ? `${m / 1024} GB` : `${m} MB`}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Replicas">
          <Input
            type="number"
            min={draft.topology === 'sentinel' ? 1 : 0}
            max={10}
            disabled={draft.topology === 'single'}
            value={draft.replicas}
            onChange={(e) => set({ replicas: Math.max(0, Number(e.target.value) || 0) })}
          />
        </Field>
      </div>
      <CacheRegionField value={draft.regions} onChange={(regions) => set({ regions })} />
      <Field label="Attach to service (optional)">
        <Select
          value={draft.attachService || 'none'}
          onValueChange={(v) => set({ attachService: v === 'none' ? '' : v })}
        >
          <SelectTrigger><SelectValue placeholder="No app yet" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No app yet</SelectItem>
            {(services.data ?? []).map((s) => (
              <SelectItem key={s.id} value={s.name}>{s.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </div>
  );
}
