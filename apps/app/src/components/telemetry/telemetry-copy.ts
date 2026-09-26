import {
  telemetryProcessorsYaml,
  type TelemetryFit,
  type TelemetryProjection,
  type TelemetrySettings,
} from '@swarmy/core';
import { toYaml, type CodeTab } from '@/components/calm';

/** Decimal gigabytes, the way disks are sold ("38.2 GB"). */
export function gb(n: number | null | undefined, digits = 1): string {
  if (n == null) return '—';
  if (n < 1e8) return `${Math.round(n / 1e6)} MB`;
  return `${(n / 1e9).toFixed(digits)} GB`;
}

/** "1 s", "1.5 s", "800 ms". */
export function duration(ms: number): string {
  return ms >= 1000 ? `${Number((ms / 1000).toFixed(1))} s` : `${ms} ms`;
}

/** "every error and 25% of the rest" — what the sampler keeps, in words (`slow` adds the slow-trace rule). */
export function keepPhrase(s: TelemetrySettings, slow = false): string {
  const { slowTraceMs, restPercent } = s.sampling;
  if (restPercent >= 100) return 'everything';
  const slowPart = slow && slowTraceMs !== null ? `, every trace slower than ${duration(slowTraceMs)}` : '';
  return `every error${slowPart} and ${restPercent}% of the rest`;
}

export const FIT_WORDS: Record<TelemetryFit, { word: string; tone: 'ok' | 'warn' | 'bad' }> = {
  comfortable: { word: 'Fits comfortably', tone: 'ok' },
  tight: { word: 'Tight', tone: 'warn' },
  'wont-fit': { word: 'Won’t fit', tone: 'bad' },
};

/** "At 25% + 14 d: ~61 GB in 30 days — wkr-1 has 120 GB free." */
export function forecastLine(
  s: TelemetrySettings,
  p: TelemetryProjection,
  node: string | null,
  freeBytes: number | null,
): string | null {
  if (p.totalBytes === null) return null;
  const share = s.sampling.restPercent >= 100 ? 'Keeping everything' : `At ${s.sampling.restPercent}%`;
  const where = node ?? 'The store’s server';
  const free = freeBytes !== null ? ` — ${where} has ${gb(freeBytes, 0)} free.` : '.';
  return `${share} + ${s.retention.tracesDays} d: ~${Math.round(p.totalBytes / 1e9)} GB in ${p.days} days${free}`;
}

/** The Code depth: the rendered collector processors and the settings document. */
export function telemetryCode(s: TelemetrySettings): CodeTab[] {
  return [
    { label: 'collector processors', code: `# otel/opentelemetry-collector-contrib · rendered by swarmy\n${telemetryProcessorsYaml(s)}` },
    { label: 'settings', code: `# swarm-kv obs/<org> · telemetry\n${toYaml(s as never)}` },
    {
      label: 'retention',
      code: [
        '# a TTL on each ClickHouse table (the exporter owns the schema)',
        `ALTER TABLE otel.otel_traces MODIFY TTL toDateTime(Timestamp) + toIntervalDay(${s.retention.tracesDays})`,
        `ALTER TABLE otel.otel_logs MODIFY TTL toDateTime(Timestamp) + toIntervalDay(${s.retention.logsDays})`,
        `ALTER TABLE otel.otel_metrics_* MODIFY TTL toDateTime(TimeUnix) + toIntervalDay(${s.retention.metricsDays})`,
      ].join('\n'),
    },
  ];
}
