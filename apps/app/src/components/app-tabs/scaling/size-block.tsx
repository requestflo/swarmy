import * as React from 'react';
import { Link } from '@tanstack/react-router';
import type { ServiceUsageView } from '@swarmy/core';
import type { ServiceSpec } from '@swarmy/core/protocol';
import { Depth, TONE_TEXT, Tech } from '@/components/calm';
import { SettingsApplyBar } from '@/components/service-settings/settings-apply-bar';
import { fmtCpu, fmtMem, sayMem } from '@/components/service-settings/settings-model';
import { Segmented } from '@/components/service-settings/settings-row';
import type { SettingsDraftState } from '@/components/service-settings/use-settings-draft';
import { TextSkeleton } from '@/components/states';
import { copyMonthlyUsd, sizeCostLine, sizeCostTech, usdWords, type SizeCostBasis } from './size-cost';
import { SIZES, SIZE_NAMES, sizeBytes, sizeDraft, sizeOf, sizeSentence, tooSmall, type Limits } from './size-model';

/**
 * Size of each copy: the swarmy.yaml presets as CPU + memory limits. Picking
 * one builds the settings panel's draft; Apply sends only the changed limits
 * through `services.update` (a rolling restart, one copy at a time). With
 * priced servers each size says what a copy costs a month (`size-cost.ts`).
 */
export function SizeBlock({
  spec,
  usage,
  draft,
  cost,
  copies,
}: {
  spec: ServiceSpec | null | undefined;
  usage: ServiceUsageView | null | undefined;
  draft: SettingsDraftState;
  /** The servers' prices: undefined while loading, null with none priced. */
  cost: SizeCostBasis | null | undefined;
  copies: number;
}): React.JSX.Element {
  const live: Limits | undefined = spec?.resources?.limits;
  const next: Limits = {
    cpus: draft.draft.cpuLimit ?? live?.cpus,
    memoryBytes: draft.draft.memLimit ?? live?.memoryBytes,
  };
  const picked = sizeOf(next);
  const costLine = cost ? sizeCostLine(cost, next, copies) : null;
  const optionLabel = (n: (typeof SIZE_NAMES)[number]): string => (cost ? `${n} · ${usdWords(copyMonthlyUsd(cost, sizeBytes(n)))}` : n);
  return (
    <div className="flex flex-col gap-2">
      <h3 className="flex flex-wrap items-baseline gap-x-2 text-[13.5px] font-semibold">
        Size of each copy
        <Depth at="controls">
          <span className="text-muted-foreground font-mono text-[11px] font-normal">size</span>
        </Depth>
      </h3>
      {spec === undefined ? (
        <TextSkeleton className="w-64" />
      ) : spec === null ? (
        <p className="text-muted-foreground text-[13.5px]">swarmy couldn’t read this service’s limits right now.</p>
      ) : (
        <>
          <p className="text-[13.5px] leading-relaxed">{sizeSentence(live, usage)}</p>
          {costLine ? <p className="text-muted-foreground text-[13px]">{costLine}</p> : null}
          <Depth at="controls">
            {cost === null ? (
              <p className="text-muted-foreground text-[12.5px]">
                No server has a monthly price, so sizes show no cost.{' '}
                <Link to="/cost" className="text-primary font-mono text-[11.5px] hover:underline">
                  Add prices →
                </Link>
              </p>
            ) : null}
            <Segmented
              label="Size of each copy"
              mono
              options={SIZE_NAMES.map((s) => ({ value: s, label: optionLabel(s) }))}
              value={picked ?? undefined}
              disabled={draft.applying}
              onChange={(s) => draft.set(sizeDraft(s))}
            />
            {picked && picked !== sizeOf(live) && tooSmall(picked, usage) ? (
              <p className={`${TONE_TEXT.warn} text-[13px]`}>
                The busiest copy uses {sayMem(usage!.memBytes.peak)} now, more than {picked} allows: it would run out of memory.
              </p>
            ) : null}
          </Depth>
          <SettingsApplyBar d={draft} className="border-border rounded-lg border" />
          <Tech>
            {`limits.cpus ${fmtCpu(live?.cpus)} · limits.memory ${fmtMem(live?.memoryBytes)}`}
            {usage ? ` · busiest of ${usage.sampled} now: ${fmtCpu(usage.cpuCores.peak)} cpus, ${fmtMem(usage.memBytes.peak)}` : ' · no usage reported yet'}
            {picked ? ` · ${picked} = ${SIZES[picked].cpu} cpu / ${SIZES[picked].memoryMb}mb` : ''}
            {cost ? ` · ${sizeCostTech(cost)}` : ''}
          </Tech>
        </>
      )}
    </div>
  );
}
