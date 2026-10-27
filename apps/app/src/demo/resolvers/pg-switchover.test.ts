import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import type { DbSwitchoverRunView } from '@swarmy/core';
import { HANDLERS } from '../registry';
import { getStore } from '../store';

const g = globalThis as { window?: unknown };
const hadWindow = 'window' in g;

describe('pg-switchover demo (boards 15 and 39)', () => {
  beforeAll(() => {
    if (!hadWindow) g.window = { location: { origin: 'https://demo.test' } };
  });
  afterAll(() => {
    if (!hadWindow) delete g.window;
  });
  afterEach(() => setSystemTime());

  test('data/main: one copy of its two-copy standby takes the writes, and that service comes back as the one copy', () => {
    const s = getStore();
    const first = HANDLERS['db.switchover']!({ stack: 'data', cluster: 'main' }, s) as DbSwitchoverRunView;
    expect([first.target, first.targetNodeId]).toEqual(['data_main-replica', 'n-wkr-1']);
    setSystemTime(new Date(Date.now() + 9_000));
    expect((HANDLERS['db.switchoverRun']!({ stack: 'data', cluster: 'main' }, s) as DbSwitchoverRunView).status).toBe('done');
    const topo = (s.extra.data as { dbTopologies: Array<{ cluster: string; members: Array<{ service: string; role: string; desired: number }> }> }).dbTopologies.find((t) => t.cluster === 'main')!;
    expect(topo.members.map((m) => [m.service, m.role, m.desired])).toEqual([
      ['data_main-primary', 'replica', 2],
      ['data_main-replica', 'primary', 1],
    ]);
  });

  test("checkout's caught-up standby takes the writes; the run walks its steps and the roles swap", () => {
    const s = getStore();
    const first = HANDLERS['db.switchover']!({ stack: 'storefront', cluster: 'checkout', target: 'storefront_checkout-replica' }, s) as DbSwitchoverRunView;
    expect([first.status, first.from, first.target, first.targetNodeId]).toEqual(['running', 'storefront_checkout-primary', 'storefront_checkout-replica', 'n-mgr-2']);
    expect(() => HANDLERS['db.switchover']!({ stack: 'storefront', cluster: 'checkout' }, s)).toThrow('already running');

    setSystemTime(new Date(Date.now() + 9_000));
    const last = HANDLERS['db.switchoverRun']!({ stack: 'storefront', cluster: 'checkout' }, s) as DbSwitchoverRunView;
    expect(last.status).toBe('done');
    expect(last.pausedSeconds).toBe(4);
    const db = HANDLERS['db.get']!({ stack: 'storefront' }, s) as { clusters: Array<{ name: string; primary: { service: string } }> };
    expect(db.clusters.find((c) => c.name === 'checkout')?.primary.service).toBe('storefront_checkout-replica');
    const pooler = HANDLERS['db.pooler']!({ stack: 'storefront', cluster: 'checkout' }, s) as { writer: string };
    expect(pooler.writer).toBe('storefront_checkout-replica');
    // The old main copy is now the standby the next switch-over could pick.
    const repl = HANDLERS['db.replication']!({ stack: 'storefront', cluster: 'checkout' }, s) as { standbys: Array<{ service: string }> };
    expect(repl.standbys.map((r) => r.service)).toEqual(['storefront_checkout-primary']);
  });
});
