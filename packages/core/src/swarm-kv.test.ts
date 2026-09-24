import { describe, expect, test } from 'bun:test';
import {
  KV_LABEL_BYTES,
  KV_LABEL_ORG,
  SwarmKv,
  isKvError,
  kvConfigName,
  memoryKvDriver,
  parseKvConfigName,
  plainKvSealer,
  type KvSealer,
} from './swarm-kv';

const ORG = 'abcdefghijklmnopqrstuvwxyz012345'; // Better Auth ids are 32 chars

function setup(opts?: Partial<ConstructorParameters<typeof SwarmKv>[0]>) {
  let t = 1_000;
  const driver = memoryKvDriver({ now: () => t });
  const kv = new SwarmKv({ orgId: ORG, driver, sealer: plainKvSealer, now: () => t, ...opts });
  return { kv, driver, tick: (ms: number) => (t += ms) };
}

describe('swarm-kv codec', () => {
  test('config names round-trip and fit Docker’s 64-char cap with a 32-char org id', () => {
    const name = kvConfigName('ingress', ORG, 12);
    expect(name).toBe(`swarmy-kv.ingress.${ORG}.v12`);
    expect(kvConfigName('bkp-target', ORG, 999_999).length).toBeLessThanOrEqual(64);
    expect(parseKvConfigName(name)).toEqual({ collection: 'ingress', id: ORG, seq: 12 });
    expect(parseKvConfigName('swarmy-kv.ingress.x.v0')).toBeNull();
    expect(parseKvConfigName('myconfig__v2')).toBeNull();
  });

  test('keys that would overflow a config name are rejected before any write', async () => {
    const { kv, driver } = setup();
    await expect(kv.put('ingress', 'x'.repeat(41), {})).rejects.toThrow(/invalid swarm-kv id/);
    await expect(kv.put('Bad', 'a', {})).rejects.toThrow(/invalid swarm-kv collection/);
    expect(driver.configs.size).toBe(0);
  });
});

describe('swarm-kv store', () => {
  test('put → get, versions are new configs, reads come from the cache', async () => {
    const { kv, driver } = setup();
    await kv.put('ingress', ORG, { driver: 'CADDY', enabled: true });
    await kv.put('ingress', ORG, { driver: 'TRAEFIK', enabled: true });
    expect([...driver.configs.keys()]).toEqual([
      `swarmy-kv.ingress.${ORG}.v1`,
      `swarmy-kv.ingress.${ORG}.v2`,
    ]);
    driver.calls.length = 0;
    expect(await kv.get<object>('ingress', ORG)).toEqual({ driver: 'TRAEFIK', enabled: true });
    expect(driver.calls).toEqual([]); // cache hit, no Docker round-trip
    const doc = await kv.getDoc('ingress', ORG);
    expect(doc?.seq).toBe(2);
  });

  test('an unchanged value writes nothing (no raft churn from idempotent saves)', async () => {
    const { kv, driver } = setup();
    await kv.put('mesh', ORG, { a: 1, b: [1, 2] });
    await kv.put('mesh', ORG, { b: [1, 2], a: 1 }); // key order doesn't matter
    expect(driver.configs.size).toBe(1);
  });

  test('a fresh store loads the latest version of every key from the swarm', async () => {
    const { kv, driver } = setup();
    await kv.put('stack', 's1', { name: 'web' });
    await kv.put('stack', 's1', { name: 'web2' });
    await kv.put('stack', 's2', { name: 'api' });
    const fresh = new SwarmKv({ orgId: ORG, driver, sealer: plainKvSealer });
    expect(await fresh.get<object>('stack', 's1')).toEqual({ name: 'web2' });
    expect((await fresh.list<{ name: string }>('stack')).map((d) => d.value.name)).toEqual(['web2', 'api']);
  });

  test('another org’s documents in the same swarm are invisible', async () => {
    const { driver } = setup();
    const a = new SwarmKv({ orgId: 'orgA', driver, sealer: plainKvSealer });
    const b = new SwarmKv({ orgId: 'orgB', driver, sealer: plainKvSealer });
    await a.put('bkp-target', 't1', { name: 'a' });
    await b.put('bkp-target', 't2', { name: 'b' });
    expect((await a.list('bkp-target')).map((d) => d.id)).toEqual(['t1']);
    expect([...driver.configs.values()].map((c) => c.labels[KV_LABEL_ORG])).toEqual(['orgA', 'orgB']);
  });

  test('garbage-collects to the last 3 versions and keeps them for undo', async () => {
    const { kv, driver } = setup();
    for (let i = 1; i <= 5; i++) await kv.put('registry', ORG, { v: i });
    expect([...driver.configs.keys()].map((n) => parseKvConfigName(n)!.seq)).toEqual([3, 4, 5]);
    expect((await kv.versions('registry', ORG)).map((v) => v.seq)).toEqual([5, 4, 3]);
    await kv.revert('registry', ORG, 3);
    expect(await kv.get<object>('registry', ORG)).toEqual({ v: 3 });
    expect((await kv.getDoc('registry', ORG))?.seq).toBe(6);
  });

  test('delete removes every version, oldest first', async () => {
    const { kv, driver } = setup();
    await kv.put('dns-zone', 'z1', { zone: 'a.com' });
    await kv.put('dns-zone', 'z1', { zone: 'b.com' });
    driver.calls.length = 0;
    expect(await kv.delete('dns-zone', 'z1')).toBe(true);
    expect(driver.calls.filter((c) => c.startsWith('remove'))).toEqual([
      'remove swarmy-kv.dns-zone.z1.v1',
      'remove swarmy-kv.dns-zone.z1.v2',
    ]);
    expect(await kv.get<object>('dns-zone', 'z1')).toBeNull();
    expect(await kv.delete('dns-zone', 'z1')).toBe(false);
  });
});

describe('swarm-kv optimistic concurrency', () => {
  test('a lost race re-reads and re-applies the change (CAS via unique config names)', async () => {
    const { kv, driver } = setup();
    await kv.put('mesh', ORG, { peers: ['a'] });
    // A second controller (stale cache) races us to v2.
    const other = new SwarmKv({ orgId: ORG, driver, sealer: plainKvSealer });
    await other.update<{ peers: string[] }>('mesh', ORG, (cur) => ({ peers: [...(cur?.peers ?? []), 'b'] }));
    const doc = await kv.update<{ peers: string[] }>('mesh', ORG, (cur) => ({
      peers: [...(cur?.peers ?? []), 'c'],
    }));
    // Our first attempt (v2) collided; the retry saw 'b' and wrote v3.
    expect(doc?.value.peers).toEqual(['a', 'b', 'c']);
    expect(doc?.seq).toBe(3);
  });

  test('gives up loudly after bounded retries', async () => {
    const { kv, driver } = setup({ maxRetries: 2 });
    await kv.put('mesh', ORG, { n: 0 });
    let n = 0;
    driver.beforeCreate = (name) => {
      // Someone always wins the name first.
      const seq = parseKvConfigName(name)!.seq;
      driver.configs.set(name, {
        dataB64: Buffer.from(JSON.stringify({ n: ++n })).toString('base64'),
        labels: { 'swarmy.kv': '1', [KV_LABEL_ORG]: ORG, [KV_LABEL_BYTES]: '10', 'swarmy.kv.seq': String(seq) },
        createdAt: 0,
      });
    };
    const err = await kv.update('mesh', ORG, () => ({ n: 99 })).catch((e: unknown) => e);
    expect(isKvError(err, 'CONFLICT')).toBe(true);
  });

  test('concurrent in-process writes are serialised (no self-inflicted conflicts)', async () => {
    const { kv, driver } = setup();
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        kv.update<{ xs: number[] }>('canvas', ORG, (cur) => ({ xs: [...(cur?.xs ?? []), i] })),
      ),
    );
    expect((await kv.get<{ xs: number[] }>('canvas', ORG))?.xs.sort()).toEqual([0, 1, 2, 3, 4]);
    expect(driver.calls.filter((c) => c.startsWith('create')).length).toBe(5);
  });
});

describe('swarm-kv guards', () => {
  test('rejects a document over 64 KB', async () => {
    const { kv, driver } = setup();
    const err = await kv.put('stack', 's1', { compose: 'x'.repeat(70_000) }).catch((e: unknown) => e);
    expect(isKvError(err, 'TOO_LARGE')).toBe(true);
    expect(driver.configs.size).toBe(0);
  });

  test('refuses writes that would push the raft footprint past 2 MB', async () => {
    const { kv } = setup({ maxTotalBytes: 100_000 });
    await kv.put('stack', 's1', { compose: 'a'.repeat(40_000) }); // ~53 KB base64
    const err = await kv.put('stack', 's2', { compose: 'b'.repeat(40_000) }).catch((e: unknown) => e);
    expect(isKvError(err, 'BUDGET')).toBe(true);
    expect(kv.footprint()).toBeLessThan(100_000);
  });

  test('pruned versions don’t count against the budget', async () => {
    const { kv } = setup({ maxTotalBytes: 20_000, keepVersions: 1 });
    for (let i = 0; i < 10; i++) await kv.put('stack', 's1', { compose: String(i).repeat(10_000) });
    expect(kv.footprint()).toBeLessThan(20_000);
  });

  test('run state never reaches raft', async () => {
    const { kv } = setup();
    for (const field of ['updatedAt', 'lastRunAt', 'nextRunAt', 'lastSeenAt']) {
      const err = await kv.put('bkp-sched', 's1', { every: 1, [field]: 1 }).catch((e: unknown) => e);
      expect(isKvError(err, 'INVALID')).toBe(true);
    }
  });

  test('collections outside the allowlist are rejected', async () => {
    const { kv } = setup({ collections: ['ingress'] });
    await expect(kv.put('metrics', ORG, {})).rejects.toThrow(/not allowlisted/);
  });

  test('payloads are sealed at rest', async () => {
    const sealer: KvSealer = {
      seal: (s) => `sealed:${Buffer.from(s).toString('hex')}`,
      open: (s) => Buffer.from(s.replace(/^sealed:/, ''), 'hex').toString(),
    };
    const { driver } = setup();
    const kv = new SwarmKv({ orgId: ORG, driver, sealer });
    await kv.put('bkp-target', 't1', { secretKeyRef: 'v1.ciphertext' });
    const raw = Buffer.from([...driver.configs.values()][0]!.dataB64, 'base64').toString();
    expect(raw.startsWith('sealed:')).toBe(true);
    expect(raw).not.toContain('secretKeyRef');
    const fresh = new SwarmKv({ orgId: ORG, driver, sealer });
    expect(await fresh.get<object>('bkp-target', 't1')).toEqual({ secretKeyRef: 'v1.ciphertext' });
    const wrongKey = new SwarmKv({ orgId: ORG, driver, sealer: plainKvSealer });
    await expect(wrongKey.get<object>('bkp-target', 't1')).rejects.toThrow(/can't be opened/);
  });
});

describe('swarm-kv cache refresh', () => {
  test('a stale cache refreshes in the background and picks up external writes', async () => {
    const { kv, driver, tick } = setup({ refreshMs: 1_000 });
    await kv.put('obs', ORG, { enabled: false });
    const other = new SwarmKv({ orgId: ORG, driver, sealer: plainKvSealer });
    await other.put('obs', ORG, { enabled: true });
    expect(await kv.get<object>('obs', ORG)).toEqual({ enabled: false }); // still fresh
    tick(1_500);
    expect(await kv.get<object>('obs', ORG)).toEqual({ enabled: false }); // served stale, refresh kicked
    await kv.refresh();
    expect(await kv.get<object>('obs', ORG)).toEqual({ enabled: true });
  });

  test('a refresh that raced a local write never rolls the cache back', async () => {
    const { kv, driver } = setup();
    await kv.put('obs', ORG, { v: 1 });
    const realList = driver.list.bind(driver);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    driver.list = async () => {
      const snapshot = await realList();
      await gate;
      return snapshot;
    };
    const refreshing = kv.refresh();
    driver.list = realList;
    await kv.put('obs', ORG, { v: 2 });
    release();
    await refreshing;
    expect(await kv.get<object>('obs', ORG)).toEqual({ v: 2 });
  });

  test('export/import moves every document into a fresh swarm', async () => {
    const { kv } = setup();
    await kv.put('ingress', ORG, { driver: 'CADDY' });
    await kv.put('bkp-target', 't1', { bucket: 'b' });
    const docs = await kv.exportAll();
    const fresh = setup();
    expect(await fresh.kv.importAll(docs)).toBe(2);
    expect(await fresh.kv.get<object>('bkp-target', 't1')).toEqual({ bucket: 'b' });
  });
});
