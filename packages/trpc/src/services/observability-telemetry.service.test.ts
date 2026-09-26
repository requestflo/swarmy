import { describe, expect, it } from 'bun:test';
import { defaultTelemetrySettings, parseClickhouseDsn, type TelemetrySettings } from '@swarmy/core';
import { encryptSecret } from '@swarmy/core/crypto';
import type { OrgContext } from '../context';
import { desiredConfigs } from './observability.service';
import { getTelemetrySettings, setTelemetrySettings, telemetryForecast } from './observability-telemetry.service';
import { COLLECTOR_SERVICE } from './observability-stack';
import { peekKv, seedKv, useMemoryKv } from './swarm-kv.service';

process.env.SWARMY_SECRET_KEY ??= 'a'.repeat(64);

const DSN = 'http://default:pw@swarmy-clickhouse:8123/otel';

function mockCtx(services: unknown[] = []) {
  const audits: Array<{ action: string; metadata?: unknown }> = [];
  const dispatched: string[] = [];
  const hub = {
    liveInventory: () => ({ services, containers: [] }),
    nodeInventory: () => [],
    managerNode: () => undefined,
    dispatch: async (_n: string, cmd: string) => {
      dispatched.push(cmd);
      return {};
    },
  };
  const ctx = {
    activeOrgId: 'org1',
    user: { id: 'u1' },
    db: { auditLog: { create: async ({ data }: { data: { action: string; metadata?: unknown } }) => audits.push(data) } },
    hub,
  } as unknown as OrgContext;
  useMemoryKv(ctx.hub);
  return { ctx, audits, dispatched };
}

const BOARD: TelemetrySettings = {
  sampling: { keepErrors: true, slowTraceMs: 1000, restPercent: 25 },
  retention: { tracesDays: 14, logsDays: 14, metricsDays: 30 },
  redaction: defaultTelemetrySettings().redaction,
};

describe('telemetry settings (swarm-kv obs document)', () => {
  it('reads defaults over the store’s single retention when never saved', async () => {
    const { ctx } = mockCtx();
    seedKv(ctx.hub, 'org1', 'obs', 'org1', { enabled: false, clickhouseDsn: null, retentionDays: 5 });
    const view = await getTelemetrySettings(ctx);
    expect(view.suiteEnabled).toBe(false);
    expect(view.applied).toBe(false);
    expect(view.settings.retention).toEqual({ tracesDays: 5, logsDays: 5, metricsDays: 5 });
    expect(view.settings.sampling.restPercent).toBe(100);
  });

  it('saves the document, leaves retentionDays alone and audits the change once', async () => {
    const { ctx, audits, dispatched } = mockCtx();
    seedKv(ctx.hub, 'org1', 'obs', 'org1', { enabled: false, clickhouseDsn: null, retentionDays: 7 });
    const view = await setTelemetrySettings(ctx, BOARD);
    expect(view.settings).toEqual(BOARD);
    const doc = peekKv<{ telemetry: TelemetrySettings; retentionDays: number }>(ctx.hub, 'org1', 'obs', 'org1');
    expect(doc?.telemetry).toEqual(BOARD);
    // retentionDays rides on the store's spec: changing it would restart ClickHouse.
    expect(doc?.retentionDays).toBe(7);
    expect(audits.map((a) => a.action)).toEqual(['observability.setSettings']);
    // Suite off: nothing to converge.
    expect(dispatched).toEqual([]);
  });

  it('reads applied only when the running collector carries this render', async () => {
    const row = { telemetry: BOARD, retentionDays: 7 };
    const name = desiredConfigs(parseClickhouseDsn(DSN), row).collector.name;
    const collector = (configs: string[]) => ({ name: COLLECTOR_SERVICE, runningReplicas: 1, updatedAt: Date.parse('2026-09-26T10:00:00Z'), configs });
    const seed = (services: unknown[]) => {
      const m = mockCtx(services);
      seedKv(m.ctx.hub, 'org1', 'obs', 'org1', { enabled: true, clickhouseDsn: encryptSecret(DSN), ...row });
      return m.ctx;
    };
    const on = await getTelemetrySettings(seed([collector([name])]));
    expect(on).toMatchObject({ suiteEnabled: true, applied: true, appliedAt: '2026-09-26T10:00:00.000Z' });
    const stale = await getTelemetrySettings(seed([collector(['swarmy-otel-collector-config-deadbeef'])]));
    expect(stale).toMatchObject({ applied: false, appliedAt: null });
  });

  it('forecast is disabled (all nulls, never zeros) while the suite is off', async () => {
    const { ctx } = mockCtx();
    const f = await telemetryForecast(ctx);
    expect(f).toMatchObject({ status: 'disabled', signals: [], usedBytes: null, freeBytes: null, node: null });
  });
});
