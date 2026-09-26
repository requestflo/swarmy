import {
  defaultTelemetrySettings,
  SetTelemetrySettingsInput,
  type TelemetryForecastView,
  type TelemetryPipelineView,
  type TelemetrySettings,
  type TelemetrySettingsView,
} from '@swarmy/core';
import type { DemoHandler, DemoStore } from '../types';

/**
 * Demo resolvers for Activity → Telemetry (`observability.settings`,
 * `setSettings`, `forecast`, `pipeline`). The numbers match the board: the
 * store holds 38.2 GB on wkr-1 (where the demo's ClickHouse runs) with 120 GB
 * free, and at 25% + 14 days it settles at ~61 GB in 30 days.
 */

const GB = 1e9;
const HOUR = 3_600_000;

interface TelemetryDemoState {
  settings: TelemetrySettings;
  appliedAt: string;
}

function state(s: DemoStore): TelemetryDemoState {
  const existing = s.extra['telemetry'] as TelemetryDemoState | undefined;
  if (existing) return existing;
  const fresh: TelemetryDemoState = {
    settings: {
      sampling: { keepErrors: true, slowTraceMs: 1000, restPercent: 25 },
      retention: { tracesDays: 14, logsDays: 14, metricsDays: 30 },
      redaction: defaultTelemetrySettings().redaction,
    },
    appliedAt: new Date(Date.now() - 50 * HOUR).toISOString(),
  };
  s.extra['telemetry'] = fresh;
  return fresh;
}

function suiteOn(s: DemoStore): boolean {
  const obs = s.extra['observability'] as { config?: { enabled?: boolean } } | undefined;
  return obs?.config?.enabled ?? true;
}

export const telemetryHandlers: Record<string, DemoHandler> = {
  'observability.settings': (_i, s): TelemetrySettingsView => {
    const st = state(s);
    const on = suiteOn(s);
    return { settings: st.settings, suiteEnabled: on, applied: on, appliedAt: on ? st.appliedAt : null };
  },

  'observability.setSettings': (i, s): TelemetrySettingsView => {
    const parsed = SetTelemetrySettingsInput.parse(i);
    const st = state(s);
    st.settings = parsed;
    st.appliedAt = new Date().toISOString();
    const on = suiteOn(s);
    return { settings: st.settings, suiteEnabled: on, applied: on, appliedAt: on ? st.appliedAt : null };
  },

  'observability.forecast': (_i, s): TelemetryForecastView => {
    const on = suiteOn(s);
    return {
      status: on ? 'ok' : 'disabled',
      signals: on
        ? [
            { signal: 'traces', bytes: 20.1 * GB, bytesPerDay: 2.36 * GB },
            { signal: 'logs', bytes: 13.9 * GB, bytesPerDay: 1.6 * GB },
            { signal: 'metrics', bytes: 4.2 * GB, bytesPerDay: 0.2 * GB },
          ]
        : [],
      usedBytes: on ? 38.2 * GB : null,
      freeBytes: on ? 120 * GB : null,
      totalBytes: on ? 250 * GB : null,
      node: on ? 'wkr-1' : null,
      // The rate above was measured under the share that was applied at the time.
      measuredRestPercent: 25,
      measuredAt: new Date().toISOString(),
    };
  },

  'observability.pipeline': (_i, s): TelemetryPipelineView => {
    const on = suiteOn(s);
    return {
      enabled: on,
      collector: {
        status: on ? 'RUNNING' : 'OFFLINE',
        node: on ? 'wkr-1' : null,
        endpoints: ['swarmy-otel-collector:4317', 'swarmy-otel-collector:4318'],
        spansPerSecond: on ? 1900 : null,
      },
      store: { status: on ? 'RUNNING' : 'OFFLINE', node: on ? 'wkr-1' : null, bytesUsed: on ? 38.2 * GB : null, reachable: on },
    };
  },
};
