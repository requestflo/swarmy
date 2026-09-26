/**
 * ObservabilityConfig repository — swarm-kv `obs/<orgId>` (P4 slice 1).
 *
 * Whether the org's collector + ClickHouse store is on, the (secret-bearing)
 * DSN, retention and the telemetry settings (sampling / redaction / per-signal TTL). The collector's deploy state is derived from its live
 * service, never stored.
 */
import type { TelemetrySettings } from '@swarmy/core';
import { orgSingleton, type KvRow } from './kv-repo';

export interface ObservabilityConfigDoc {
  enabled: boolean;
  clickhouseDsn: string | null;
  retentionDays: number;
  /**
   * Sampling, per-signal retention and redaction (ObsSettings). Null until the
   * org saves them — readers resolve it with `defaultTelemetrySettings(retentionDays)`.
   * Org-level infra config the observability reconcile converges onto the
   * collector + store, so it lives next to the rest of this document in swarm-kv.
   */
  telemetry: TelemetrySettings | null;
}

export type ObservabilityConfigRow = KvRow<ObservabilityConfigDoc>;

export const observabilityConfigRepo = orgSingleton<ObservabilityConfigDoc>('obs', () => ({
  enabled: false,
  clickhouseDsn: null,
  retentionDays: 7,
  telemetry: null,
}));
