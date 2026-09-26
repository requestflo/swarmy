import * as React from 'react';
import type { ServiceUsageView } from '@swarmy/core';
import type { ServiceSpec } from '@swarmy/core/protocol';
import { cn } from '@swarmy/ui';
import { Depth, Tech } from '@/components/calm';
import { CPU_PRESETS, MEM_PRESETS, fmtCpu, fmtMem, sayMem, type SettingsDraft } from './settings-model';
import { Segmented, SettingRow } from './settings-row';

/** used (fill) against the limit (track), with a tick at the reservation. */
function UsageBar({ used, reserved, limit, label }: { used: number | undefined; reserved: number | undefined; limit: number; label: string }): React.JSX.Element {
  const pct = (v: number) => `${Math.min(100, Math.max(0, (v / limit) * 100))}%`;
  const hot = used !== undefined && used / limit >= 0.85;
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={limit}
      aria-valuenow={used ?? 0}
      className="bg-muted relative h-2 w-full min-w-16 flex-1 overflow-hidden rounded-full"
    >
      {used !== undefined ? (
        <span className={cn('absolute inset-y-0 left-0 rounded-full', hot ? 'bg-status-warning' : 'bg-status-online')} style={{ width: pct(used) }} />
      ) : null}
      {reserved !== undefined ? <span aria-hidden className="bg-foreground/50 absolute inset-y-0 w-0.5" style={{ left: pct(reserved) }} /> : null}
    </div>
  );
}

interface KnobProps {
  spec: ServiceSpec;
  usage: ServiceUsageView | null | undefined;
  draft: SettingsDraft;
  set: (p: SettingsDraft) => void;
}

function CpuKnob({ spec, usage, draft, set }: KnobProps): React.JSX.Element {
  const limit = draft.cpuLimit ?? spec.resources?.limits?.cpus;
  const reserved = spec.resources?.reservations?.cpus;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="text-muted-foreground w-16 text-[12.5px]">CPU</span>
      <Depth at="controls">
        {limit ? <UsageBar label="CPU used of the limit" used={usage?.cpuCores.peak} reserved={reserved} limit={limit} /> : null}
      </Depth>
      <Segmented label="CPU per copy" mono options={CPU_PRESETS.map((v) => ({ value: v, label: fmtCpu(v) }))} value={limit} onChange={(v) => set({ cpuLimit: v })} />
    </div>
  );
}

function MemKnob({ spec, usage, draft, set }: KnobProps): React.JSX.Element {
  const limit = draft.memLimit ?? spec.resources?.limits?.memoryBytes;
  const reserved = spec.resources?.reservations?.memoryBytes;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="text-muted-foreground w-16 text-[12.5px]">Memory</span>
      <Depth at="controls">
        {limit ? <UsageBar label="Memory used of the limit" used={usage?.memBytes.peak} reserved={reserved} limit={limit} /> : null}
      </Depth>
      <Segmented label="Memory per copy" mono options={MEM_PRESETS.map((v) => ({ value: v, label: fmtMem(v) }))} value={limit} onChange={(v) => set({ memLimit: v })} />
    </div>
  );
}

/** The plain sentence: the ceiling per copy and what the busiest copy uses now. */
function resourcesSay(spec: ServiceSpec, usage: ServiceUsageView | null | undefined): string {
  const lim = spec.resources?.limits;
  const cap =
    lim?.cpus !== undefined || lim?.memoryBytes !== undefined
      ? `Each copy can use up to ${[lim.cpus !== undefined ? `${fmtCpu(lim.cpus)} CPU` : null, lim.memoryBytes !== undefined ? sayMem(lim.memoryBytes) : null].filter(Boolean).join(' and ')}.`
      : 'No ceiling: each copy can use as much of its server as it likes.';
  if (!usage) return cap;
  const share = lim?.memoryBytes ? ` (${Math.round((usage.memBytes.peak / lim.memoryBytes) * 100)}% of its limit)` : '';
  return `${cap} The busiest uses ${sayMem(usage.memBytes.peak)} now${share}.`;
}

export function ResourcesRow(props: KnobProps): React.JSX.Element {
  const { spec, usage } = props;
  const r = spec.resources;
  return (
    <SettingRow title="Resources" hint={<Depth at="controls">reserved · limit · used</Depth>}>
      <p className="text-[13.5px]">{resourcesSay(spec, usage)}</p>
      <CpuKnob {...props} />
      <MemKnob {...props} />
      <Tech>
        cpus {fmtCpu(r?.reservations?.cpus)} · {fmtCpu(r?.limits?.cpus)} · {usage ? fmtCpu(usage.cpuCores.peak) : '—'} — memory{' '}
        {fmtMem(r?.reservations?.memoryBytes)} · {fmtMem(r?.limits?.memoryBytes)} · {usage ? fmtMem(usage.memBytes.peak) : '—'}
        {usage ? ` · busiest of ${usage.sampled} ${usage.sampled === 1 ? 'copy' : 'copies'}` : ' · no usage reported yet'}
      </Tech>
    </SettingRow>
  );
}
