import { describe, expect, test } from 'bun:test';
import type { DB } from '@swarmy/db';
import type { AgentHub } from '../hub/types';
import { seedKv, swarmKvFor, useMemoryKv } from './swarm-kv.service';
import { createKvWarmer, warmLogLine } from './swarm-kv-warm';

/** A hub with `managers` connected and an org table listing `orgs`. */
function world(orgs: string[], managers: Record<string, string>) {
  const hub = { managerNode: (orgId: string) => managers[orgId] } as unknown as AgentHub;
  const drivers = useMemoryKv(hub);
  const db = { organization: { findMany: async () => orgs.map((id) => ({ id })) } } as unknown as DB;
  const logs: string[] = [];
  const errors: string[] = [];
  let t = 0;
  const warmer = createKvWarmer(
    { hub, db },
    { log: (l) => logs.push(l), error: (l) => errors.push(l), retryMs: 1_000, now: () => t },
  );
  return { hub, drivers, warmer, logs, errors, tick: (ms: number) => (t += ms) };
}

describe('swarm-kv boot warm-up', () => {
  test('loads every org with a manager at boot, so the first read is a cache hit', async () => {
    const w = world(['org1', 'org2'], { org1: 'mgr-1' });
    seedKv(w.hub, 'org1', 'ingress', 'org1', { driver: 'CADDY' });
    seedKv(w.hub, 'org1', 'bkp-target', 't1', { bucket: 'b' });
    const out = await w.warmer.tick();
    expect(out.map((o) => [o.orgId, o.status, o.docs])).toEqual([['org1', 'loaded', 2]]); // org2: no manager yet
    expect(w.logs[0]).toMatch(/^\[swarm-kv\] org org1: loaded 2 document\(s\), \d+\.\d KB of 2048\.0 KB in raft$/);
    const driver = w.drivers.get('org1')!;
    driver.calls.length = 0;
    expect(await swarmKvFor(w.hub, 'org1').get<object>('ingress', 'org1')).toEqual({ driver: 'CADDY' });
    expect(driver.calls).toEqual([]); // no Docker round-trip on the first request
    expect(await w.warmer.tick()).toEqual([]); // loaded orgs cost nothing on later passes
  });

  test('an org whose manager connects later is warmed on that pass', async () => {
    const managers: Record<string, string> = {};
    const w = world(['org1'], managers);
    seedKv(w.hub, 'org1', 'mesh', 'org1', { enabled: true });
    expect(await w.warmer.tick()).toEqual([]);
    managers.org1 = 'mgr-1';
    expect((await w.warmer.tick())[0]?.status).toBe('loaded');
  });

  test('a broken document shows at startup with a clear line, logged once and retried later', async () => {
    const w = world(['org1'], { org1: 'mgr-1' });
    seedKv(w.hub, 'org1', 'bkp-target', 't1', { bucket: 'b' });
    for (const c of w.drivers.get('org1')!.configs.values()) c.dataB64 = Buffer.from('{oops').toString('base64');
    const [o] = await w.warmer.tick();
    expect(o?.status).toBe('failed');
    expect(w.errors).toHaveLength(1);
    expect(w.errors[0]).toContain("[swarm-kv] org org1: can't load swarm config: swarm-kv bkp-target/t1 v1 can't be opened");
    expect(w.errors[0]).toContain('SWARMY_SECRET_KEY');
    expect(await w.warmer.tick()).toEqual([]); // inside the retry window: no Docker churn
    w.tick(1_500);
    expect((await w.warmer.tick())[0]?.status).toBe('failed');
    expect(w.errors).toHaveLength(1); // the same error isn't logged again
  });

  test('the log line reads in KB against the 2 MB budget', () => {
    expect(warmLogLine({ orgId: 'o', status: 'loaded', docs: 3, bytes: 3_072 }, 2 * 1024 * 1024)).toBe(
      '[swarm-kv] org o: loaded 3 document(s), 3.0 KB of 2048.0 KB in raft',
    );
  });
});
