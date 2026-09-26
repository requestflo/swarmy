import { describe, expect, it } from 'bun:test';
import { EdgeTrafficSample, MetricsMsg, MetricsPayload } from './stats';
import { AgentEnvelope, AgentToControllerMessage, ControllerToAgentMessage, parseAgentEnvelope } from './messages';
import { PROTOCOL_VERSION } from './constants';

const ID = '00000000-0000-4000-8000-000000000001';
const base = {
  sampledAt: 1_700_000_000_000,
  node: { cpuPercent: 12.5, memUsedBytes: 1024, memTotalBytes: 4096 },
  containers: [],
};
const edge = {
  sampledAt: 1_700_000_000_000,
  intervalSec: 15,
  hosts: [
    { host: 'shop.example.com', requests: 120, errors5xx: 3 },
    { host: 'api.example.com', requests: 0, errors5xx: 0 },
  ],
};

describe('metrics.edge — per-edge request counts (optional, backward compatible)', () => {
  it('an older agent payload without `edge` still parses', () => {
    const r = MetricsPayload.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.edge).toBeUndefined();
  });

  it('carries per-host deltas when present and round-trips unchanged', () => {
    const r = MetricsPayload.safeParse({ ...base, edge });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.edge).toEqual(edge);
    expect(MetricsPayload.parse(JSON.parse(JSON.stringify({ ...base, edge })))).toEqual({ ...base, edge });
  });

  it('rejects negative or fractional counts, an empty host and a zero interval', () => {
    const bad = (h: object) => EdgeTrafficSample.safeParse({ ...edge, hosts: [h] }).success;
    expect(bad({ host: 'a.test', requests: -1, errors5xx: 0 })).toBe(false);
    expect(bad({ host: 'a.test', requests: 1.5, errors5xx: 0 })).toBe(false);
    expect(bad({ host: '', requests: 1, errors5xx: 0 })).toBe(false);
    expect(bad({ host: 'a.test', requests: 1 })).toBe(false);
    expect(EdgeTrafficSample.safeParse({ ...edge, intervalSec: 0 }).success).toBe(false);
    expect(MetricsPayload.safeParse({ ...base, edge: { hosts: [] } }).success).toBe(false);
  });

  it('wraps in MetricsMsg and the AgentToControllerMessage union with the metrics discriminant', () => {
    const msg = { type: 'metrics', payload: { ...base, edge } };
    const m = MetricsMsg.safeParse(msg);
    expect(m.success).toBe(true);
    const u = AgentToControllerMessage.safeParse(msg);
    expect(u.success).toBe(true);
    if (u.success) expect(u.data.type).toBe('metrics');
    expect(MetricsMsg.safeParse({ type: 'metric', payload: msg.payload }).success).toBe(false);
    expect(ControllerToAgentMessage.safeParse(msg).success).toBe(false);
  });

  it('parses inside a full agent envelope', () => {
    const env = parseAgentEnvelope({ v: PROTOCOL_VERSION, id: ID, ts: 1, type: 'metrics', payload: { ...base, edge } });
    expect(env.type).toBe('metrics');
    if (env.type === 'metrics') expect(env.payload.edge?.hosts).toHaveLength(2);
    expect(AgentEnvelope.safeParse({ v: PROTOCOL_VERSION, id: ID, ts: 1, type: 'metricz', payload: base }).success).toBe(false);
  });
});
