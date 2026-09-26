import * as React from 'react';
import { CheckIcon } from 'lucide-react';
import { Input, cn } from '@swarmy/ui';
import {
  TELEMETRY_REST_PRESETS,
  TELEMETRY_RETENTION_PRESETS,
  type TelemetrySettings,
  type TelemetrySignal,
} from '@swarmy/core';
import { Section, Tech } from '@/components/calm';
import { QuietSwitch } from '@/components/rowpage/row-page';
import { duration } from './telemetry-copy';
import { Segments } from './telemetry-segments';

const KEY: Record<TelemetrySignal, keyof TelemetrySettings['retention']> = {
  traces: 'tracesDays',
  logs: 'logsDays',
  metrics: 'metricsDays',
};
const LABEL: Record<TelemetrySignal, string> = { traces: 'Traces kept for', logs: 'Logs kept for', metrics: 'Metrics kept for' };

function Card({ children, className }: { children: React.ReactNode; className?: string }): React.JSX.Element {
  return <div className={cn('border-border bg-background/60 flex min-w-0 flex-col gap-1.5 rounded-xl border px-3 py-2.5', className)}>{children}</div>;
}

/** Keep the preset list honest: a saved value off the presets still shows. */
function withValue(presets: readonly number[], v: number): number[] {
  return presets.includes(v) ? [...presets] : [...presets, v].sort((a, b) => a - b);
}

/** What we keep: every error, slow traces, a share of the rest — and for how long. */
export function TelemetryKeep({
  s,
  change,
}: {
  s: TelemetrySettings;
  change: (fn: (s: TelemetrySettings) => TelemetrySettings) => void;
}): React.JSX.Element {
  const slow = s.sampling.slowTraceMs;
  const setSampling = (patch: Partial<TelemetrySettings['sampling']>) =>
    change((c) => ({ ...c, sampling: { ...c.sampling, ...patch } }));
  return (
    <Section title="What we keep" hint="decided once the whole trace is in">
      <div className="grid gap-2 sm:grid-cols-2 2xl:grid-cols-3">
        <Card>
          <span className="flex items-center gap-1.5 text-[13.5px] font-semibold">
            <CheckIcon className="text-tone-ok size-4" aria-hidden /> Every error
          </span>
          <span className="text-muted-foreground text-xs">always kept, never sampled</span>
        </Card>
        <Card>
          <span className="flex items-center gap-2 text-[13.5px] font-semibold">
            <QuietSwitch checked={slow !== null} onCheckedChange={(on) => setSampling({ slowTraceMs: on ? 1000 : null })} aria-label="Always keep slow traces" />
            Slow traces {slow !== null ? `> ${duration(slow)}` : ''}
          </span>
          {slow !== null ? (
            <label className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs">
              slower than
              <Input
                type="number"
                min={50}
                max={600000}
                step={50}
                value={slow}
                onChange={(e) => setSampling({ slowTraceMs: Math.max(50, Math.min(600_000, Math.round(Number(e.target.value) || 50))) })}
                className="h-7 w-20 px-1.5 font-mono text-xs pointer-coarse:min-h-11"
                aria-label="Slow trace threshold in milliseconds"
              />
              <span className="whitespace-nowrap">ms · always kept</span>
            </label>
          ) : (
            <span className="text-muted-foreground text-xs">off — kept only by the share below</span>
          )}
        </Card>
        <Card className="sm:col-span-2 2xl:col-span-1">
          <span className="text-[13.5px] font-semibold">Everything else</span>
          <Segments
            label="Share of the other traces kept"
            value={s.sampling.restPercent}
            options={withValue(TELEMETRY_REST_PRESETS, s.sampling.restPercent)}
            onChange={(v) => setSampling({ restPercent: v })}
            format={(v) => `${v}%`}
          />
        </Card>
      </div>
      <Tech>tail_sampling · status_code ERROR · latency ≥ threshold · probabilistic share · 100% runs no sampler</Tech>
      <div className="border-border flex flex-col gap-2 border-t pt-3">
        {(Object.keys(KEY) as TelemetrySignal[]).map((sig) => (
          <div key={sig} className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
            <span className="text-[13px] font-semibold">{LABEL[sig]}</span>
            <Segments
              label={LABEL[sig]}
              value={s.retention[KEY[sig]]}
              options={withValue(TELEMETRY_RETENTION_PRESETS[sig], s.retention[KEY[sig]])}
              onChange={(v) => change((c) => ({ ...c, retention: { ...c.retention, [KEY[sig]]: v } }))}
              format={(v) => `${v} d`}
            />
          </div>
        ))}
      </div>
      <Tech>Retention is a TTL on each ClickHouse table. Shortening it drops old data at the next merge.</Tech>
    </Section>
  );
}
