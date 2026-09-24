/**
 * swarm-kv against a real Docker Swarm manager.
 *
 * Runs when `SWARMY_KV_DOCKER` points at a swarm manager's Engine API
 * (`unix:///var/run/docker.sock`, or `tcp://127.0.0.1:2375` for a throwaway
 * `docker:dind` that ran `docker swarm init`), or when the local socket is
 * already a swarm manager. Otherwise it skips. Every config it creates uses a
 * unique org id and is removed afterwards.
 *
 *   docker run -d --privileged --name kv-dind -p 23750:2375 \
 *     -e DOCKER_TLS_CERTDIR= docker:27-dind
 *   docker exec kv-dind docker swarm init
 *   SWARMY_KV_DOCKER=tcp://127.0.0.1:23750 bun test src/swarm-kv.integration.test.ts
 */
import { afterAll, describe, expect, test } from 'bun:test';
import Docker from 'dockerode';
import { SwarmKv, isKvError, type KvSealer } from './swarm-kv';
import { dockerKvDriver } from './swarm-kv-docker';

function connect(): Docker {
  const url = process.env.SWARMY_KV_DOCKER ?? `unix://${process.env.DOCKER_SOCKET ?? '/var/run/docker.sock'}`;
  if (url.startsWith('unix://')) return new Docker({ socketPath: url.slice('unix://'.length) });
  const u = new URL(url);
  return new Docker({ host: u.hostname, port: Number(u.port || 2375), protocol: 'http' });
}

async function isSwarmManager(docker: Docker): Promise<boolean> {
  try {
    const info = (await docker.info()) as { Swarm?: { LocalNodeState?: string; ControlAvailable?: boolean } };
    return info.Swarm?.LocalNodeState === 'active' && info.Swarm.ControlAvailable === true;
  } catch {
    return false;
  }
}

const docker = connect();
const available = await isSwarmManager(docker);
const ORG = `it${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const hexSealer: KvSealer = {
  seal: (s) => Buffer.from(s).toString('hex'),
  open: (s) => Buffer.from(s, 'hex').toString(),
};

describe.skipIf(!available)('swarm-kv on a real swarm', () => {
  const driver = dockerKvDriver(docker);
  const kv = () => new SwarmKv({ orgId: ORG, driver, sealer: hexSealer, refreshMs: 0 });

  afterAll(async () => {
    for (const c of await driver.list()) {
      if (c.labels['swarmy.kv.org'] === ORG) await driver.remove(c.name).catch(() => undefined);
    }
  });

  test('write, reload from raft, version, GC', async () => {
    const a = kv();
    for (let i = 1; i <= 4; i++) await a.put('ingress', ORG, { driver: 'CADDY', n: i });
    const names = (await driver.list())
      .filter((c) => c.labels['swarmy.kv.org'] === ORG)
      .map((c) => c.name)
      .sort();
    expect(names).toEqual([2, 3, 4].map((n) => `swarmy-kv.ingress.${ORG}.v${n}`));
    const b = kv();
    expect(await b.get<object>('ingress', ORG)).toEqual({ driver: 'CADDY', n: 4 });
    const doc = await b.getDoc('ingress', ORG);
    expect(doc?.updatedAt).toBeGreaterThan(0); // Docker CreatedAt, not a stored timestamp
  });

  test('Docker’s unique config names are the compare-and-swap', async () => {
    const a = kv();
    const b = kv();
    await a.put('mesh', ORG, { xs: ['a'] });
    await b.update<{ xs: string[] }>('mesh', ORG, (c) => ({ xs: [...(c?.xs ?? []), 'b'] }));
    // `a` still believes v1 is latest: its first create of v2 hits "already exists".
    const out = await a.update<{ xs: string[] }>('mesh', ORG, (c) => ({ xs: [...(c?.xs ?? []), 'c'] }));
    expect(out?.value.xs).toEqual(['a', 'b', 'c']);
    expect(out?.seq).toBe(3);
  });

  test('payloads are sealed in raft; delete removes every version', async () => {
    const a = new SwarmKv({ orgId: ORG, driver, sealer: hexSealer });
    await a.put('bkp-target', 't1', { bucket: 'offsite' });
    const raw = Buffer.from(await driver.read(`swarmy-kv.bkp-target.t1.v1`), 'base64').toString();
    expect(raw).not.toContain('offsite');
    expect(await a.delete('bkp-target', 't1')).toBe(true);
    expect((await driver.list()).some((c) => c.name.startsWith('swarmy-kv.bkp-target.t1.'))).toBe(false);
  });

  test('oversized documents never reach Docker', async () => {
    const a = new SwarmKv({ orgId: ORG, driver, sealer: hexSealer });
    const err = await a.put('stack', 'big', { compose: 'x'.repeat(80_000) }).catch((e: unknown) => e);
    expect(isKvError(err, 'TOO_LARGE')).toBe(true);
  });
});
