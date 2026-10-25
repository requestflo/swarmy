import { describe, expect, it } from 'bun:test';
import { PROTOCOL_VERSION } from './constants';
import { AgentEnvelope, AgentToControllerMessage, ControllerToAgentMessage, parseAgentEnvelope } from './messages';
import { MetricsMsg, MetricsPayload } from './stats';
import { MAX_REPORTED_VOLUMES, VolumeSizesSample } from './volume-sizes';

const ID = '00000000-0000-4000-8000-000000000002';
const base = {
  sampledAt: 1_700_000_000_000,
  node: { cpuPercent: 3, memUsedBytes: 1024, memTotalBytes: 4096, fsUsedBytes: 10, fsTotalBytes: 100 },
  containers: [],
};
const volumes = {
  sampledAt: 1_700_000_000_000,
  volumes: [
    { name: 'shop_pg', sizeBytes: 4_509_715_660, refCount: 1 },
    { name: 'shop_cache', sizeBytes: 0 },
  ],
};

describe('metrics.volumes — each local volume`s size (additive, optional)', () => {
  it('an older agent`s metrics without `volumes` still parse', () => {
    const r = MetricsPayload.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.volumes).toBeUndefined();
  });

  it('carries the sizes when present and round-trips unchanged through JSON', () => {
    const r = MetricsPayload.safeParse({ ...base, volumes });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.volumes).toEqual(volumes);
    expect(MetricsPayload.parse(JSON.parse(JSON.stringify({ ...base, volumes })))).toEqual({ ...base, volumes });
  });

  it('rejects a negative or fractional size, an empty name, a missing sampledAt and an oversized list', () => {
    const bad = (v: object) => VolumeSizesSample.safeParse({ ...volumes, volumes: [v] }).success;
    expect(bad({ name: 'a', sizeBytes: -1 })).toBe(false);
    expect(bad({ name: 'a', sizeBytes: 1.5 })).toBe(false);
    expect(bad({ name: '', sizeBytes: 1 })).toBe(false);
    expect(bad({ name: 'a' })).toBe(false);
    expect(VolumeSizesSample.safeParse({ volumes: [] }).success).toBe(false);
    const many = Array.from({ length: MAX_REPORTED_VOLUMES + 1 }, (_, i) => ({ name: `v${i}`, sizeBytes: i }));
    expect(VolumeSizesSample.safeParse({ sampledAt: 1, volumes: many }).success).toBe(false);
    expect(MetricsPayload.safeParse({ ...base, volumes: { sampledAt: 1, volumes: [{ name: 'a', sizeBytes: -5 }] } }).success).toBe(false);
  });

  it('a field this schema does not know is dropped, not a refused frame (how older controllers read newer agents)', () => {
    const r = MetricsMsg.safeParse({ type: 'metrics', payload: { ...base, volumes: { ...volumes, volumes: [{ name: 'x', sizeBytes: 1, driver: 'local' }] } } });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.payload.volumes?.volumes[0]).toEqual({ name: 'x', sizeBytes: 1 });
  });

  it('wraps in MetricsMsg and the AgentToControllerMessage union with the metrics discriminant', () => {
    const msg = { type: 'metrics', payload: { ...base, volumes } };
    expect(MetricsMsg.safeParse(msg).success).toBe(true);
    const u = AgentToControllerMessage.safeParse(msg);
    expect(u.success).toBe(true);
    if (u.success) expect(u.data.type).toBe('metrics');
    expect(MetricsMsg.safeParse({ type: 'volumeSizes', payload: msg.payload }).success).toBe(false);
    expect(ControllerToAgentMessage.safeParse(msg).success).toBe(false);
  });

  it('parses inside a full agent envelope', () => {
    const env = parseAgentEnvelope({ v: PROTOCOL_VERSION, id: ID, ts: 1, type: 'metrics', payload: { ...base, volumes } });
    expect(env.type).toBe('metrics');
    if (env.type === 'metrics') expect(env.payload.volumes?.volumes.map((v) => v.name)).toEqual(['shop_pg', 'shop_cache']);
    expect(AgentEnvelope.safeParse({ v: PROTOCOL_VERSION, id: ID, ts: 1, type: 'volumeSizes', payload: volumes }).success).toBe(false);
  });
});
