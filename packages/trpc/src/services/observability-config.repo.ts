/**
 * ObservabilityConfig repository — swarm-kv `obs/<orgId>` (P4 slice 1).
 *
 * Whether the org's collector + ClickHouse store is on, the (secret-bearing)
 * DSN and retention. The collector's deploy state is derived from its live
 * service, never stored.
 */
import { orgSingleton, type KvRow } from './kv-repo';

export interface ObservabilityConfigDoc {
  enabled: boolean;
  clickhouseDsn: string | null;
  retentionDays: number;
}

export type ObservabilityConfigRow = KvRow<ObservabilityConfigDoc>;

export const observabilityConfigRepo = orgSingleton<ObservabilityConfigDoc>('obs', () => ({
  enabled: false,
  clickhouseDsn: null,
  retentionDays: 7,
}));
