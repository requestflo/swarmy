import { describe, expect, test } from 'bun:test';
import { SwarmKv, isKvError, memoryKvDriver, plainKvSealer } from './swarm-kv';

const ORG = 'abcdefghijklmnopqrstuvwxyz012345';

function setup() {
  let t = 1_000;
  const driver = memoryKvDriver({ now: () => t });
  const kv = new SwarmKv({ orgId: ORG, driver, sealer: plainKvSealer, now: () => t });
  return { kv, driver, tick: (ms: number) => (t += ms) };
}

/** Overwrite every stored version's payload with something that won't parse. */
function corrupt(driver: ReturnType<typeof memoryKvDriver>, match: string): void {
  for (const [name, c] of driver.configs) {
    if (name.includes(match)) c.dataB64 = Buffer.from('{not json').toString('base64');
  }
}

describe('swarm-kv describe (metadata for warm-up, sizes and the versions list)', () => {
  test('lists each document with its latest size and every retained version, newest first', async () => {
    const { kv, tick } = setup();
    await kv.put('ingress', ORG, { driver: 'CADDY' });
    tick(10);
    await kv.put('ingress', ORG, { driver: 'TRAEFIK', extra: 'x'.repeat(100) });
    await kv.put('bkp-target', 't1', { bucket: 'b' });
    const docs = await kv.describe();
    expect(docs.map((d) => `${d.collection}/${d.id}`)).toEqual(['bkp-target/t1', `ingress/${ORG}`]);
    const ingress = docs[1]!;
    expect(ingress.seq).toBe(2);
    expect(ingress.versions.map((v) => v.seq)).toEqual([2, 1]);
    expect(ingress.bytes).toBe(ingress.versions[0]!.bytes);
    expect(ingress.bytes).toBeGreaterThan(ingress.versions[1]!.bytes);
    expect(ingress.updatedAt).toBe(1_010);
    expect(kv.limits).toEqual({ maxDocBytes: 64 * 1024, maxTotalBytes: 2 * 1024 * 1024, keepVersions: 3 });
  });

  test('a fresh store loads from the swarm on describe (the boot warm-up path)', async () => {
    const { kv, driver } = setup();
    await kv.put('obs', ORG, { enabled: true });
    const fresh = new SwarmKv({ orgId: ORG, driver, sealer: plainKvSealer });
    expect(fresh.loaded).toBe(false);
    expect((await fresh.describe()).length).toBe(1);
    expect(fresh.loaded).toBe(true);
  });
});

describe('swarm-kv load: broken documents', () => {
  test('every document that cannot be opened is named, and nothing is half-loaded', async () => {
    const { kv, driver } = setup();
    await kv.put('ingress', ORG, { driver: 'CADDY' });
    await kv.put('bkp-target', 't1', { bucket: 'b' });
    await kv.put('bkp-target', 't2', { bucket: 'c' });
    corrupt(driver, 'bkp-target');
    const fresh = new SwarmKv({ orgId: ORG, driver, sealer: plainKvSealer });
    const err = await fresh.refresh().catch((e: unknown) => e);
    expect(isKvError(err, 'INVALID')).toBe(true);
    expect((err as Error).message).toContain("2 swarm-kv documents can't be opened");
    expect((err as Error).message).toContain('bkp-target/t1 v1');
    expect((err as Error).message).toContain('bkp-target/t2 v1');
    expect(fresh.loaded).toBe(false); // a missing document must never read as "not configured"
  });

  test('one broken document keeps the single-document message', async () => {
    const { kv, driver } = setup();
    await kv.put('mesh', ORG, { enabled: true });
    corrupt(driver, 'mesh');
    const fresh = new SwarmKv({ orgId: ORG, driver, sealer: plainKvSealer });
    await expect(fresh.refresh()).rejects.toThrow(/^swarm-kv mesh\/.* v1 can't be opened/);
  });

  test('an unreachable swarm is not reported as a broken document', async () => {
    const { driver } = setup();
    driver.list = async () => {
      throw new Error('no manager');
    };
    const fresh = new SwarmKv({ orgId: ORG, driver, sealer: plainKvSealer });
    await expect(fresh.refresh()).rejects.toThrow('no manager');
  });
});
