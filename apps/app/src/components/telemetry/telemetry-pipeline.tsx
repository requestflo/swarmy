import * as React from 'react';
import { cn } from '@swarmy/ui';
import type { TelemetryPipelineView, TelemetryServiceStatus } from '@swarmy/core';
import { Section, Tech, TONE_DOT, type Tone } from '@/components/calm';
import { gb } from './telemetry-copy';

const TONE: Record<TelemetryServiceStatus, Tone> = { RUNNING: 'ok', DEPLOYING: 'info', FAILED: 'bad', OFFLINE: 'idle' };
const WORD: Record<TelemetryServiceStatus, string> = { RUNNING: 'running', DEPLOYING: 'starting', FAILED: 'not running', OFFLINE: 'off' };

function Box({
  title,
  status,
  say,
  tech,
}: {
  title: string;
  status: TelemetryServiceStatus;
  say: string;
  tech: string;
}): React.JSX.Element {
  return (
    <div className="bg-background/60 border-border flex min-w-0 flex-col gap-0.5 rounded-xl border px-3 py-2.5">
      <span className="flex items-center gap-2 text-[13.5px] font-semibold">
        <span aria-hidden className={cn('size-2 rounded-full', TONE_DOT[TONE[status]])} />
        {title}
        <span className="text-muted-foreground text-xs font-normal">{WORD[status]}</span>
      </span>
      <span className="text-muted-foreground text-[12.5px]">{say}</span>
      <Tech>{tech}</Tech>
    </div>
  );
}

/** Collector → store, where each runs and what flows between them. */
export function TelemetryPipeline({ pipeline }: { pipeline: TelemetryPipelineView | undefined }): React.JSX.Element {
  const c = pipeline?.collector;
  const s = pipeline?.store;
  const rate = c?.spansPerSecond;
  return (
    <Section title="Pipeline" hint="one collector, one store, both part of swarmy">
      <div className="grid gap-2 sm:grid-cols-2">
        <Box
          title="Collector"
          status={c?.status ?? 'OFFLINE'}
          say={c?.node ? `on ${c.node}` : 'no server yet'}
          tech={`OTel Collector · OTLP ${c?.endpoints.map((e) => e.slice(e.lastIndexOf(':'))).join(' / ') ?? ':4317 / :4318'}${
            rate != null ? ` · ${rate >= 100 ? `${(rate / 1000).toFixed(1)}k` : rate.toFixed(1)} spans/s stored` : ''
          }`}
        />
        <Box
          title="Store"
          status={s?.status ?? 'OFFLINE'}
          say={s?.node ? `on ${s.node}${s.bytesUsed != null ? ` · ${gb(s.bytesUsed)} used` : ''}` : 'no server yet'}
          tech={`ClickHouse · ${s?.reachable ? 'reachable' : 'not reachable'}`}
        />
      </div>
      <div aria-hidden className="relative mt-1 h-3">
        <div className="border-muted-foreground/40 absolute inset-x-1 top-1/2 border-t border-dashed" />
        <span className="bg-status-online absolute top-1/2 left-0 size-2.5 -translate-y-1/2 rounded-full" />
        <span className="bg-status-progress absolute top-1/2 left-1/2 size-2.5 -translate-1/2 rounded-full" />
        <span className="bg-tone-mesh absolute top-1/2 right-0 size-2.5 -translate-y-1/2 rounded-full" />
      </div>
      <div className="text-muted-foreground flex justify-between gap-2 font-mono text-[11px]">
        <span>apps</span>
        <span className="text-center">sampling + scrubbing</span>
        <span>store</span>
      </div>
    </Section>
  );
}
