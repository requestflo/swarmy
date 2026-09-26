import { describe, expect, it } from 'bun:test';
import { SetTelemetrySettingsInput, TelemetryRedactionRule, type TelemetrySettings } from './inputs';
import {
  defaultTelemetrySettings,
  projectTelemetryForecast,
  renderTelemetryProcessors,
  telemetryProcessorsYaml,
  type TelemetryForecastView,
} from './telemetry';

const GB = 1e9;

function board(): TelemetrySettings {
  return {
    sampling: { keepErrors: true, slowTraceMs: 1000, restPercent: 25 },
    retention: { tracesDays: 14, logsDays: 14, metricsDays: 30 },
    redaction: defaultTelemetrySettings().redaction,
  };
}

describe('renderTelemetryProcessors (collector golden)', () => {
  it('renders the board settings byte-for-byte', () => {
    expect(telemetryProcessorsYaml(board())).toBe(
      [
        'processors:',
        '  attributes/redact_spans:',
        '    actions:',
        '      # Drop the Authorization header',
        "      - pattern: '^http\\.request\\.header\\.authorization$'",
        '        action: delete',
        '      # Drop Cookie / Set-Cookie',
        "      - pattern: '^http\\.(request\\.header\\.cookie|response\\.header\\.set-cookie)$'",
        '        action: delete',
        '  transform/redact_spans:',
        '    error_mode: ignore',
        '    trace_statements:',
        '      - context: span',
        '        statements:',
        `          - 'replace_all_patterns(attributes, "value", "\\\\b\\\\d{13,16}\\\\b", "****")'`,
        '  tail_sampling:',
        '    decision_wait: 10s',
        '    num_traces: 50000',
        '    policies:',
        '      - name: keep-every-error',
        '        type: status_code',
        '        status_code:',
        '          status_codes: [ERROR]',
        '      - name: keep-slow-traces',
        '        type: latency',
        '        latency:',
        '          threshold_ms: 1000',
        '      - name: keep-share-of-the-rest',
        '        type: probabilistic',
        '        probabilistic:',
        '          sampling_percentage: 25',
        '  attributes/redact_logs:',
        '    actions:',
        '      # Drop the Authorization header',
        "      - pattern: '^http\\.request\\.header\\.authorization$'",
        '        action: delete',
        '  transform/redact_logs:',
        '    error_mode: ignore',
        '    log_statements:',
        '      - context: log',
        '        statements:',
        `          - 'replace_all_patterns(attributes, "value", "\\\\b\\\\d{13,16}\\\\b", "****")'`,
        `          - 'replace_pattern(body, "\\\\b\\\\d{13,16}\\\\b", "****") where IsString(body)'`,
        '',
        'service:',
        '  pipelines:',
        '    traces:',
        '      processors: [resource, attributes/redact_spans, transform/redact_spans, tail_sampling, batch]',
        '    logs:',
        '      processors: [resource, attributes/redact_logs, transform/redact_logs, batch]',
        '    metrics:',
        '      processors: [resource, batch]',
        '',
      ].join('\n'),
    );
  });

  it('keeps everything with no sampler at 100%, and drops the slow rule when off', () => {
    const all = renderTelemetryProcessors({ ...board(), sampling: { keepErrors: true, slowTraceMs: 1000, restPercent: 100 } });
    expect(all.pipelines.traces).not.toContain('tail_sampling');
    const noSlow = renderTelemetryProcessors({ ...board(), sampling: { keepErrors: true, slowTraceMs: null, restPercent: 10 } });
    expect(noSlow.lines.join('\n')).not.toContain('keep-slow-traces');
    expect(noSlow.lines.join('\n')).toContain('sampling_percentage: 10');
    expect(noSlow.lines.join('\n')).toContain('status_codes: [ERROR]');
  });

  it('renders nothing for disabled rules and escapes quotes for YAML and OTTL', () => {
    const none = renderTelemetryProcessors({ ...board(), redaction: [], sampling: { keepErrors: true, slowTraceMs: null, restPercent: 100 } });
    expect(none).toEqual({ lines: [], pipelines: { traces: [], logs: [], metrics: [] } });
    const quoted = renderTelemetryProcessors({
      ...board(),
      redaction: [{ id: 'q', name: "it's", kind: 'mask-regex', target: 'log', match: 'a"b', replace: "x'y", enabled: true }],
    });
    expect(quoted.lines).toContain(`          - 'replace_all_patterns(attributes, "value", "a\\"b", "x''y")'`);
  });
});

describe('TelemetrySettings input', () => {
  it('accepts the board settings and pins keepErrors on', () => {
    expect(SetTelemetrySettingsInput.safeParse(board()).success).toBe(true);
    const off = { ...board(), sampling: { ...board().sampling, keepErrors: false } };
    expect(SetTelemetrySettingsInput.safeParse(off).success).toBe(false);
  });

  it('rejects regexes RE2 cannot compile, masks without a replacement, and duplicate ids', () => {
    const rule = { id: 'r', name: 'r', kind: 'mask-regex', target: 'log', match: 'a', replace: 'b', enabled: true };
    expect(TelemetryRedactionRule.safeParse(rule).success).toBe(true);
    expect(TelemetryRedactionRule.safeParse({ ...rule, match: '(?=a)b' }).success).toBe(false);
    expect(TelemetryRedactionRule.safeParse({ ...rule, match: '(a)\\1' }).success).toBe(false);
    expect(TelemetryRedactionRule.safeParse({ ...rule, match: '(' }).success).toBe(false);
    expect(TelemetryRedactionRule.safeParse({ ...rule, replace: undefined }).success).toBe(false);
    const dup = { ...board(), redaction: [rule, rule] };
    expect(SetTelemetrySettingsInput.safeParse(dup).success).toBe(false);
  });

  it('defaults keep every trace and the store’s single retention on each signal', () => {
    const d = defaultTelemetrySettings(7);
    expect(d.sampling.restPercent).toBe(100);
    expect(d.retention).toEqual({ tracesDays: 7, logsDays: 7, metricsDays: 7 });
    expect(d.redaction.map((r) => [r.id, r.enabled])).toEqual([
      ['drop-authorization', true],
      ['drop-cookies', true],
      ['mask-card-numbers', true],
      ['mask-emails', false],
    ]);
  });
});

describe('projectTelemetryForecast', () => {
  const view: TelemetryForecastView = {
    status: 'ok',
    signals: [
      { signal: 'traces', bytes: 20.1 * GB, bytesPerDay: 2.36 * GB },
      { signal: 'logs', bytes: 13.9 * GB, bytesPerDay: 1.6 * GB },
      { signal: 'metrics', bytes: 4.2 * GB, bytesPerDay: 0.2 * GB },
    ],
    usedBytes: 38.2 * GB,
    freeBytes: 120 * GB,
    totalBytes: 200 * GB,
    node: 'wkr-1',
    measuredRestPercent: 25,
    measuredAt: '2026-09-26T00:00:00.000Z',
  };

  it('grows until the TTL holds each signal at rate × retention (the board’s ~61 GB)', () => {
    const p = projectTelemetryForecast(view, board());
    expect(p.points?.[0]).toBeCloseTo(38.2 * GB, -6);
    expect(p.perSignal.map((s) => Math.round((s.projectedBytes ?? 0) / 1e8) / 10)).toEqual([33, 22.4, 6]);
    expect(Math.round((p.totalBytes ?? 0) / GB)).toBe(61);
    expect(p.fit).toBe('comfortable');
  });

  it('keeps what is stored when the share drops; it ages out under the TTL', () => {
    const p = projectTelemetryForecast(view, { ...board(), sampling: { keepErrors: true, slowTraceMs: 1000, restPercent: 10 } });
    expect(p.points?.[0]).toBeCloseTo(38.2 * GB, -6);
    expect((p.perSignal[0]?.projectedBytes ?? 0) / GB).toBeCloseTo(0.944 * 14, 2);
    // A shorter retention drops the excess at the next merge.
    const short = projectTelemetryForecast(view, { ...board(), retention: { tracesDays: 3, logsDays: 14, metricsDays: 30 } });
    expect((short.points?.[0] ?? 0) / GB).toBeCloseTo(2.36 * 3 + 13.9 + 4.2, 1);
  });

  it('scales the trace rate by the draft share and flags a tight disk', () => {
    const p = projectTelemetryForecast(view, { ...board(), sampling: { keepErrors: true, slowTraceMs: 1000, restPercent: 100 } });
    expect(p.perSignal[0]?.bytesPerDay).toBeCloseTo(9.44 * GB, -6);
    const tight = projectTelemetryForecast({ ...view, freeBytes: 30 * GB }, board());
    expect(tight.fit).toBe('tight');
    expect(projectTelemetryForecast({ ...view, freeBytes: 20 * GB }, board()).fit).toBe('wont-fit');
  });

  it('never guesses: an unmeasured signal or disk gives nulls', () => {
    const blind = projectTelemetryForecast({ ...view, signals: [{ signal: 'traces', bytes: 1, bytesPerDay: null }] }, board());
    expect(blind.points).toBeNull();
    expect(blind.totalBytes).toBeNull();
    expect(blind.fit).toBeNull();
    expect(projectTelemetryForecast({ ...view, freeBytes: null }, board()).fit).toBeNull();
  });
});
