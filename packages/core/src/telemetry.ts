/**
 * Telemetry settings (ObsSettings board): what the ONE self-deployed OTel
 * Collector keeps, for how long, and what it scrubs first. Pure — shared by the
 * controller (the collector render, the forecast) and the dashboard (the Code
 * view renders the exact same processors YAML from a draft).
 *
 * Processors are all in `otel/opentelemetry-collector-contrib` (the image the
 * suite deploys, pinned in `observability-stack.ts`): `tail_sampling`,
 * `attributes` and `transform`. Pipeline order per signal:
 *
 *   traces:  resource → attributes/redact_spans → transform/redact_spans → tail_sampling → batch
 *   logs:    resource → attributes/redact_logs  → transform/redact_logs  → batch
 *   metrics: resource → batch
 *
 * Redaction runs BEFORE the sampler so a secret never sits in its decision
 * buffer; the sampler runs before `batch` because it needs whole traces.
 */
import type { TelemetryRedactionRule, TelemetrySettings } from './inputs';

export type TelemetrySignal = 'traces' | 'logs' | 'metrics';
export const TELEMETRY_SIGNALS: readonly TelemetrySignal[] = ['traces', 'logs', 'metrics'];

/** The "Everything else" presets on the board (any 1–100 is valid). */
export const TELEMETRY_REST_PRESETS = [5, 10, 25, 100] as const;
/** Retention segments per signal on the board. */
export const TELEMETRY_RETENTION_PRESETS: Record<TelemetrySignal, readonly number[]> = {
  traces: [3, 7, 14, 30],
  logs: [3, 7, 14, 30],
  metrics: [14, 30, 90, 365],
};

/** How long the sampler waits for a trace's last span before deciding. */
export const TAIL_DECISION_WAIT_S = 10;
/** Traces held in memory while waiting (the collector's bound). */
export const TAIL_NUM_TRACES = 50_000;

/**
 * The default redaction rules: credentials and card numbers scrubbed, emails in
 * logs left as-is until you turn it on (they are often the only way to find a
 * user's request).
 */
export function defaultRedactionRules(): TelemetryRedactionRule[] {
  return [
    {
      id: 'drop-authorization',
      name: 'Drop the Authorization header',
      kind: 'drop-attr',
      target: 'both',
      match: '^http\\.request\\.header\\.authorization$',
      enabled: true,
    },
    {
      id: 'drop-cookies',
      name: 'Drop Cookie / Set-Cookie',
      kind: 'drop-attr',
      target: 'span',
      match: '^http\\.(request\\.header\\.cookie|response\\.header\\.set-cookie)$',
      enabled: true,
    },
    {
      id: 'mask-card-numbers',
      name: 'Mask card numbers',
      kind: 'mask-regex',
      target: 'both',
      match: '\\b\\d{13,16}\\b',
      replace: '****',
      enabled: true,
    },
    {
      id: 'mask-emails',
      name: 'Mask email addresses in logs',
      kind: 'mask-regex',
      target: 'log',
      match: '[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\\.[A-Za-z]{2,})',
      replace: '***@$1',
      enabled: false,
    },
  ];
}

/**
 * Settings for an org that never saved any: keep everything (no sampler, so an
 * upgrade never silently drops traces), the store's existing single retention
 * on every signal, and the default redaction rules.
 */
export function defaultTelemetrySettings(retentionDays = 7): TelemetrySettings {
  const days = Math.min(365, Math.max(1, Math.floor(retentionDays)));
  return {
    sampling: { keepErrors: true, slowTraceMs: 1000, restPercent: 100 },
    retention: { tracesDays: days, logsDays: days, metricsDays: days },
    redaction: defaultRedactionRules(),
  };
}

/** The longest retention of the three (the exporter's create-time TTL). */
export function maxRetentionDays(s: TelemetrySettings): number {
  return Math.max(s.retention.tracesDays, s.retention.logsDays, s.retention.metricsDays);
}

/** Whether the collector runs a tail sampler at all (100% ⇒ keep everything, no buffer). */
export function samplerActive(s: TelemetrySettings): boolean {
  return s.sampling.restPercent < 100;
}

/* ----------------------------------------------------------------------------
 * Collector processors render
 * ------------------------------------------------------------------------- */

export interface TelemetryProcessorsRender {
  /** YAML lines for the `processors:` map, indented two spaces (no header). */
  lines: string[];
  /** Processors to run between `resource` and `batch`, per pipeline. */
  pipelines: Record<TelemetrySignal, string[]>;
}

/** A YAML single-quoted scalar (only `'` needs doubling). */
function yq(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** An OTTL double-quoted string literal. */
function ottl(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function forSpans(r: TelemetryRedactionRule): boolean {
  return r.target === 'span' || r.target === 'both';
}
function forLogs(r: TelemetryRedactionRule): boolean {
  return r.target === 'log' || r.target === 'both';
}

function attributesProcessor(name: string, rules: TelemetryRedactionRule[]): string[] {
  if (rules.length === 0) return [];
  return [
    `  ${name}:`,
    '    actions:',
    ...rules.flatMap((r) => [`      # ${r.name}`, `      - pattern: ${yq(r.match)}`, '        action: delete']),
  ];
}

function transformProcessor(
  name: string,
  context: 'span' | 'log',
  rules: TelemetryRedactionRule[],
): string[] {
  if (rules.length === 0) return [];
  const statements = rules.flatMap((r) => {
    const args = `${ottl(r.match)}, ${ottl(r.replace ?? '')}`;
    const out = [`replace_all_patterns(attributes, "value", ${args})`];
    // A log body is often a plain string — scrub it too (skipped when structured).
    if (context === 'log') out.push(`replace_pattern(body, ${args}) where IsString(body)`);
    return out;
  });
  return [
    `  ${name}:`,
    '    error_mode: ignore',
    `    ${context === 'span' ? 'trace' : 'log'}_statements:`,
    `      - context: ${context}`,
    '        statements:',
    ...statements.map((s) => `          - ${yq(s)}`),
  ];
}

function tailSamplingProcessor(s: TelemetrySettings): string[] {
  if (!samplerActive(s)) return [];
  const slow = s.sampling.slowTraceMs;
  return [
    '  tail_sampling:',
    `    decision_wait: ${TAIL_DECISION_WAIT_S}s`,
    `    num_traces: ${TAIL_NUM_TRACES}`,
    '    policies:',
    // Policies are OR'd: a trace is kept when ANY of them says keep.
    '      - name: keep-every-error',
    '        type: status_code',
    '        status_code:',
    '          status_codes: [ERROR]',
    ...(slow !== null
      ? ['      - name: keep-slow-traces', '        type: latency', '        latency:', `          threshold_ms: ${slow}`]
      : []),
    '      - name: keep-share-of-the-rest',
    '        type: probabilistic',
    '        probabilistic:',
    `          sampling_percentage: ${s.sampling.restPercent}`,
  ];
}

/**
 * Render the sampling + redaction processors. Deterministic for a given input
 * (golden-tested); disabled rules render nothing.
 */
export function renderTelemetryProcessors(s: TelemetrySettings): TelemetryProcessorsRender {
  const on = s.redaction.filter((r) => r.enabled);
  const drop = on.filter((r) => r.kind === 'drop-attr');
  const mask = on.filter((r) => r.kind === 'mask-regex');
  const blocks: Array<[string, string[], TelemetrySignal]> = [
    ['attributes/redact_spans', attributesProcessor('attributes/redact_spans', drop.filter(forSpans)), 'traces'],
    ['transform/redact_spans', transformProcessor('transform/redact_spans', 'span', mask.filter(forSpans)), 'traces'],
    ['tail_sampling', tailSamplingProcessor(s), 'traces'],
    ['attributes/redact_logs', attributesProcessor('attributes/redact_logs', drop.filter(forLogs)), 'logs'],
    ['transform/redact_logs', transformProcessor('transform/redact_logs', 'log', mask.filter(forLogs)), 'logs'],
  ];
  const pipelines: Record<TelemetrySignal, string[]> = { traces: [], logs: [], metrics: [] };
  const lines: string[] = [];
  for (const [name, body, signal] of blocks) {
    if (body.length === 0) continue;
    lines.push(...body);
    pipelines[signal].push(name);
  }
  return { lines, pipelines };
}

/** The full processors + pipelines excerpt, as the Code view shows it. */
export function telemetryProcessorsYaml(s: TelemetrySettings): string {
  const r = renderTelemetryProcessors(s);
  const chain = (sig: TelemetrySignal) => `[${['resource', ...r.pipelines[sig], 'batch'].join(', ')}]`;
  return [
    'processors:',
    ...(r.lines.length ? r.lines : ['  # nothing to sample or redact']),
    '',
    'service:',
    '  pipelines:',
    ...TELEMETRY_SIGNALS.flatMap((sig) => [`    ${sig}:`, `      processors: ${chain(sig)}`]),
    '',
  ].join('\n');
}

/* ----------------------------------------------------------------------------
 * Disk forecast (projection over the measured numbers)
 * ------------------------------------------------------------------------- */

export interface TelemetrySignalUsage {
  signal: TelemetrySignal;
  /** Bytes on disk now (ClickHouse `system.parts`), null when unmeasured. */
  bytes: number | null;
  /** Average bytes written per full day over the last 7 days, null when unmeasured. */
  bytesPerDay: number | null;
}

/** Raw numbers the controller measures; the dashboard projects them. */
export interface TelemetryForecastView {
  status: 'ok' | 'disabled' | 'unreachable';
  signals: TelemetrySignalUsage[];
  /** Total bytes used by the store's tables now. */
  usedBytes: number | null;
  /** Free / total bytes on the disk ClickHouse writes to (`system.disks`). */
  freeBytes: number | null;
  totalBytes: number | null;
  /** Hostname of the server hosting the store, when known. */
  node: string | null;
  /** The sampling share the measured rate was written under (the applied setting). */
  measuredRestPercent: number;
  measuredAt: string;
}

export type TelemetryFit = 'comfortable' | 'tight' | 'wont-fit';

export interface TelemetryProjection {
  days: number;
  /** Projected total bytes per day 0..days; null when any signal is unmeasured. */
  points: number[] | null;
  perSignal: Array<{ signal: TelemetrySignal; bytesPerDay: number | null; days: number; projectedBytes: number | null }>;
  /** Projected total at the horizon. */
  totalBytes: number | null;
  fit: TelemetryFit | null;
}

/**
 * Project each signal's size over `horizon` days under `settings`. What is
 * stored now was written at the measured rate, so it spans `bytes / rate` days
 * and ages out under the (draft) retention; new data arrives at the draft rate
 * and holds at rate × retention once the TTL starts dropping the oldest day.
 * A shortened retention drops the excess at the next merge. The trace rate is
 * scaled from the share it was measured under to the draft share —
 * approximate, since errors and slow traces are kept either way.
 */
export function projectTelemetryForecast(
  view: TelemetryForecastView,
  settings: TelemetrySettings,
  horizon = 30,
): TelemetryProjection {
  const retention: Record<TelemetrySignal, number> = {
    traces: settings.retention.tracesDays,
    logs: settings.retention.logsDays,
    metrics: settings.retention.metricsDays,
  };
  const perSignal = TELEMETRY_SIGNALS.map((signal) => {
    const u = view.signals.find((x) => x.signal === signal);
    const scale = signal === 'traces' ? settings.sampling.restPercent / Math.max(1, view.measuredRestPercent) : 1;
    const measured = u?.bytesPerDay ?? null;
    const rate = measured === null ? null : measured * scale;
    const r = retention[signal];
    const at = (d: number): number | null => {
      if (u?.bytes == null || measured === null || rate === null) return null;
      // Days of history the stored bytes span (all of the window when nothing is written).
      const span = measured > 0 ? u.bytes / measured : r;
      const old = measured > 0 ? measured * Math.max(0, Math.min(span, r - d)) : d < r ? u.bytes : 0;
      return old + rate * Math.min(d, r);
    };
    return { signal, bytesPerDay: rate, days: r, at };
  });
  const complete = perSignal.every((p) => p.at(0) !== null);
  const points = complete
    ? Array.from({ length: horizon + 1 }, (_, d) => perSignal.reduce((a, p) => a + (p.at(d) ?? 0), 0))
    : null;
  const totalBytes = points ? (points[horizon] ?? null) : null;
  let fit: TelemetryFit | null = null;
  if (totalBytes !== null && view.freeBytes !== null && view.usedBytes !== null) {
    const growth = totalBytes - view.usedBytes;
    fit = growth <= view.freeBytes * 0.5 ? 'comfortable' : growth <= view.freeBytes * 0.9 ? 'tight' : 'wont-fit';
  }
  return {
    days: horizon,
    points,
    perSignal: perSignal.map(({ signal, bytesPerDay, days, at }) => ({ signal, bytesPerDay, days, projectedBytes: at(horizon) })),
    totalBytes,
    fit,
  };
}

/* ----------------------------------------------------------------------------
 * Pipeline + settings views
 * ------------------------------------------------------------------------- */

export type TelemetryServiceStatus = 'OFFLINE' | 'DEPLOYING' | 'RUNNING' | 'FAILED';

export interface TelemetryPipelineView {
  enabled: boolean;
  collector: {
    status: TelemetryServiceStatus;
    node: string | null;
    /** In-swarm OTLP endpoints apps send to. */
    endpoints: string[];
    /** Spans stored per second over the last 5 minutes (after sampling), null when unmeasured. */
    spansPerSecond: number | null;
  };
  store: {
    status: TelemetryServiceStatus;
    node: string | null;
    bytesUsed: number | null;
    reachable: boolean;
  };
}

export interface TelemetrySettingsView {
  /** The saved settings (defaults when the org never saved any). */
  settings: TelemetrySettings;
  /** The telemetry store + collector are deployed at all. */
  suiteEnabled: boolean;
  /** The running collector carries the render of these settings. */
  applied: boolean;
  /** When the collector last took a new config (its service update time), when applied. */
  appliedAt: string | null;
}

/** Deep-equal for two settings documents (the "unapplied changes" check). */
export function sameTelemetrySettings(a: TelemetrySettings, b: TelemetrySettings): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
