import { describe, expect, test } from 'bun:test';
import { memoryKvDriver } from '@swarmy/core';
import { TRPCError } from '@trpc/server';
import type { AgentHub } from '../hub/types';
import {
  exportKvForBundle,
  importKvFromBundle,
  kvFor,
  newKvId,
  swarmKvFor,
  useHubKv,
  useMemoryKv,
} from './swarm-kv.service';

process.env.SWARMY_SECRET_KEY ||= 'swarm-kv-test-key';

/** A hub whose manager agent answers `config.*` from an in-memory Docker fake. */
function fakeHub(manager: string | null = 'mgr-1') {
  const docker = memoryKvDriver();
  const dispatched: string[] = [];
  const hub = {
    managerNode: () => manager ?? undefined,
    async dispatch(nodeId: string, cmd: string, p: Record<string, unknown>) {
      dispatched.push(`${nodeId} ${cmd}`);
      if (cmd === 'config.list') return { configs: await docker.list() };
      if (cmd === 'config.inspect') return { name: p.name, dataB64: await docker.read(p.name as string), labels: {}, createdAt: 0 };
      if (cmd === 'config.create') return docker.create(p.name as string, p.dataB64 as string, p.labels as Record<string, string>);
      if (cmd === 'config.remove') return docker.remove(p.name as string);
      throw new Error(`unexpected ${cmd}`);
    },
  } as unknown as AgentHub;
  useHubKv(hub); // exercise the production driver (bun test defaults to the in-memory fake)
  return { hub, docker, dispatched };
}

const noNodes = { node: { count: async () => 0 } } as never;
const someNodes = { node: { count: async () => 2 } } as never;

describe('swarm-kv via the hub', () => {
  test('writes go to the org’s manager as config.create, vault-sealed', async () => {
    const { hub, docker, dispatched } = fakeHub();
    await kvFor({ hub }, 'org1').put('ingress', 'org1', { driver: 'CADDY', enabled: true });
    expect(dispatched).toContain('mgr-1 config.create');
    const [cfg] = [...docker.configs.values()];
    const stored = Buffer.from(cfg!.dataB64, 'base64').toString();
    expect(stored.startsWith('v1.')).toBe(true); // encryptSecret envelope
    expect(stored).not.toContain('CADDY');
    // A second controller (fresh cache) reads it back through the agent.
    const hub2 = { ...hub } as AgentHub;
    useHubKv(hub2);
    expect(await kvFor({ hub: hub2 }, 'org1').get<object>('ingress', 'org1')).toEqual({ driver: 'CADDY', enabled: true });
  });

  test('no manager + no enrolled node ⇒ empty (there is no swarm yet)', async () => {
    const { hub } = fakeHub(null);
    expect(await kvFor({ hub, db: noNodes }, 'org1').get<object>('ingress', 'org1')).toBeNull();
    expect(await kvFor({ hub, db: noNodes }, 'org1').list('stack')).toEqual([]);
  });

  test('no manager but nodes enrolled ⇒ NO_MANAGER, never a fake “nothing configured”', async () => {
    const { hub } = fakeHub(null);
    const err = await kvFor({ hub, db: someNodes }, 'org1').get<object>('ingress', 'org1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe('PRECONDITION_FAILED');
  });

  test('writes with no manager fail loudly', async () => {
    const { hub } = fakeHub(null);
    const err = await kvFor({ hub, db: noNodes }, 'org1').put('mesh', 'org1', {}).catch((e: unknown) => e);
    expect((err as TRPCError).code).toBe('PRECONDITION_FAILED');
  });

  test('oversized documents surface as PAYLOAD_TOO_LARGE', async () => {
    const { hub } = fakeHub();
    useMemoryKv(hub);
    const err = await kvFor({ hub }, 'org1')
      .put('stack', newKvId(), { composeSource: 'x'.repeat(70_000) })
      .catch((e: unknown) => e);
    expect((err as TRPCError).code).toBe('PAYLOAD_TOO_LARGE');
  });

  test('collections are allowlisted', async () => {
    const { hub } = fakeHub();
    useMemoryKv(hub);
    await expect(swarmKvFor(hub, 'org1').put('metric-sample', 'x', {})).rejects.toThrow(/not allowlisted/);
  });

  test('bundle export → import rebuilds a fresh swarm', async () => {
    const a = fakeHub();
    useMemoryKv(a.hub);
    await kvFor({ hub: a.hub }, 'org1').put('bkp-target', 'ct1', { bucket: 'b', resticPasswordRef: 'v1.x' });
    await kvFor({ hub: a.hub }, 'org2').put('ingress', 'org2', { driver: 'NONE' });
    const { section, skipped } = await exportKvForBundle(a.hub, ['org1', 'org2', 'org3']);
    expect(skipped).toEqual([]);
    expect(section.orgs.map((o) => o.orgId)).toEqual(['org1', 'org2']);

    const b = fakeHub();
    useMemoryKv(b.hub);
    const out = await importKvFromBundle(b.hub, section);
    expect(out).toEqual({ written: 2, pending: [] });
    expect(await kvFor({ hub: b.hub }, 'org1').get<object>('bkp-target', 'ct1')).toEqual({ bucket: 'b', resticPasswordRef: 'v1.x' });
  });

  test('new ids are cuid-shaped and fit a config name', () => {
    const id = newKvId();
    expect(id).toMatch(/^c[a-z0-9]{24}$/);
    expect(`swarmy-kv.bkp-target.${id}.v999999`.length).toBeLessThanOrEqual(64);
  });
});
