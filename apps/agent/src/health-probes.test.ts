import { describe, expect, it } from 'bun:test';
import type { ContainerHealth, ContainerInfo } from '@swarmy/core/protocol';
import { createHealthProber, HEALTH_MAX_PER_TICK, HEALTH_TTL_MS } from './health-probes';

const ctr = (id: string, status: string, state: ContainerInfo['state'] = 'running'): ContainerInfo => ({
  id,
  name: id,
  image: 'web:1',
  state,
  status,
  createdAt: 1,
  ports: [],
  labels: {},
});

const HEALTHY: ContainerHealth = { status: 'healthy', failingStreak: 0, probes: [{ at: 1, durationMs: 4, exitCode: 0 }] };

function reader(result: (id: string) => ContainerHealth | undefined = () => HEALTHY) {
  const calls: string[] = [];
  return { calls, read: async (id: string) => (calls.push(id), result(id)) };
}

describe('createHealthProber — the probe log on the snapshot, read sparingly', () => {
  it('inspects only running containers that have a check', async () => {
    const r = reader();
    const out = await createHealthProber(r.read)([ctr('a', 'Up 1 min (healthy)'), ctr('b', 'Up 1 min'), ctr('c', 'Exited (0)', 'exited')], 0);
    expect(r.calls).toEqual(['a']);
    expect(out.map((c) => c.health)).toEqual([HEALTHY, undefined, undefined]);
  });

  it('serves from cache inside the TTL, re-reads after it or when the health word changes', async () => {
    const r = reader();
    const probe = createHealthProber(r.read);
    await probe([ctr('a', 'Up (healthy)')], 0);
    await probe([ctr('a', 'Up (healthy)')], HEALTH_TTL_MS - 1);
    expect(r.calls).toEqual(['a']);
    await probe([ctr('a', 'Up (unhealthy)')], HEALTH_TTL_MS - 1);
    await probe([ctr('a', 'Up (healthy)')], 3 * HEALTH_TTL_MS);
    expect(r.calls).toEqual(['a', 'a', 'a']);
  });

  it('caps the inspects per tick', async () => {
    const r = reader();
    const many = Array.from({ length: HEALTH_MAX_PER_TICK + 5 }, (_, i) => ctr(`c${i}`, 'Up (healthy)'));
    await createHealthProber(r.read)(many, 0);
    expect(r.calls).toHaveLength(HEALTH_MAX_PER_TICK);
  });

  it('a failed inspect leaves health out instead of failing the snapshot', async () => {
    const probe = createHealthProber(async () => {
      throw new Error('gone');
    });
    expect((await probe([ctr('a', 'Up (healthy)')], 0))[0]?.health).toBeUndefined();
  });
});
