import { describe, expect, it } from 'bun:test';
import type { Auth } from '@swarmy/auth';
import type { DB } from '@swarmy/db';
import { MIRROR_OK_MARKER, SYSTEM_IMAGES, copySourceFor, type SystemImage, type SystemImageKey } from '@swarmy/core/system-images';
import type { AgentHub } from '../hub/types';
import { copyOnce, type CopyOutcome, type Flights } from './system-images-flights';
import { mirrorSystemImagesForOrg } from './system-images.service';
import { seedKv } from './swarm-kv.service';

/**
 * Concurrent pre-copies of the same image share one copy (nightly e2e: the
 * upgrade preflight and the mirror tick each copied ~30 images at once).
 */
const d = (c: string) => `sha256:${c.repeat(64)}`;
const img = (key: string, digest = d('a')): SystemImage => ({ key: key as SystemImageKey, ref: `example.com/${key}:1`, digest });

function deferredCopies() {
  const calls: string[][] = [];
  const pending: Array<{ items: SystemImage[]; resolve: (o: CopyOutcome) => void; reject: (e: Error) => void }> = [];
  const copy = (items: SystemImage[]) =>
    new Promise<CopyOutcome>((resolve, reject) => {
      calls.push(items.map((i) => i.key));
      pending.push({ items, resolve, reject });
    });
  const finish = (i: number) =>
    pending[i]!.resolve({ ok: new Map(pending[i]!.items.map((x) => [x.key, x.digest!] as const)), failed: [] });
  return { calls, pending, copy, finish };
}

describe('copyOnce: one copy of an image per org at a time', () => {
  it('a second caller waits for the copy already in flight instead of starting it again', async () => {
    const flights: Flights = new Map();
    const c = deferredCopies();
    const first = copyOnce('o1', [img('x'), img('y')], c.copy, flights);
    const second = copyOnce('o1', [img('y'), img('z')], c.copy, flights);
    expect(c.calls).toEqual([['x', 'y'], ['z']]);
    c.finish(1);
    c.finish(0);
    const [a, b] = await Promise.all([first, second]);
    expect([...a.ok.keys()].map(String).sort()).toEqual(['x', 'y']);
    expect([...b.ok.keys()].map(String).sort()).toEqual(['y', 'z']);
    expect(b.joined.map(String)).toEqual(['y']);
    // Settled copies leave the map: it is not a cache.
    expect(flights.size).toBe(0);
    const again = copyOnce('o1', [img('y')], c.copy, flights);
    expect(c.calls).toHaveLength(3);
    c.finish(2);
    expect((await again).joined).toEqual([]);
  });

  it('another org, or another digest of the same image, is a different copy', () => {
    const flights: Flights = new Map();
    const c = deferredCopies();
    void copyOnce('o1', [img('x')], c.copy, flights);
    void copyOnce('o2', [img('x')], c.copy, flights);
    void copyOnce('o1', [img('x', d('b'))], c.copy, flights);
    expect(c.calls).toEqual([['x'], ['x'], ['x']]);
  });

  it('an image a copy from before a restart is still copying is in flight for the starter and for whoever joined', async () => {
    const flights: Flights = new Map();
    const c = deferredCopies();
    const first = copyOnce('o1', [img('x'), img('y')], c.copy, flights);
    const second = copyOnce('o1', [img('y')], c.copy, flights);
    c.pending[0]!.resolve({ ok: new Map([['x' as SystemImageKey, d('a')]]), failed: [], inFlight: ['y' as SystemImageKey] });
    expect(await first).toMatchObject({ failed: [], inFlight: ['y'] });
    expect(await second).toMatchObject({ failed: [], inFlight: ['y'], joined: ['y'] });
  });

  it("the starter sees its own failure; a caller that joined reports those images as failed", async () => {
    const flights: Flights = new Map();
    const c = deferredCopies();
    const first = copyOnce('o1', [img('x')], c.copy, flights);
    const second = copyOnce('o1', [img('x')], c.copy, flights);
    c.pending[0]!.reject(new Error('agent went away'));
    await expect(first).rejects.toThrow('agent went away');
    expect(await second).toMatchObject({ failed: ['x'], joined: ['x'] });
    expect(flights.size).toBe(0);
  });
});

describe('mirrorSystemImagesForOrg: a preflight during a mirror tick starts no second copy', () => {
  it('two concurrent mirrors of the same release run one labelled regctl copy per image', async () => {
    const images = SYSTEM_IMAGES.filter((i) => !i.bundleOnly).slice(0, 3).map((i) => ({ ...i, digest: i.digest ?? d('c') }));
    const runs: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const registry = { id: 'svc-reg', name: 'swarmy-registry', image: 'registry:2', labels: {} };
    const task = { id: 't', serviceId: 'svc-reg', state: 'running', labels: { 'com.docker.swarm.node.id': 'swarmn1' } };
    const hub = {
      liveInventory: () => ({ services: [registry], containers: [task] }),
      managerNode: () => 'm1',
      dispatch: async (_n: string, cmd: string, p: { copyKey?: string }) => {
        if (cmd !== 'container.runOnce') return {};
        runs.push(String(p.copyKey));
        await gate;
        return { exitCode: 0, output: images.map((i) => `${MIRROR_OK_MARKER} ${i.key} ${i.digest}`).join('\n') };
      },
    } as unknown as AgentHub;
    seedKv(hub, 'o1', 'registry', 'o1', { enabled: true, host: 'localhost:5000', credentialsEnc: null });
    const deps = { db: {} as DB, hub, auth: {} as Auth };
    const tick = mirrorSystemImagesForOrg(deps, 'o1', undefined, images);
    const preflight = mirrorSystemImagesForOrg(deps, 'o1', undefined, images);
    await new Promise((r) => setTimeout(r, 10));
    release();
    const [a, b] = await Promise.all([tick, preflight]);
    expect(runs).toEqual(images.map((i) => copySourceFor(i)));
    expect(a.copied.sort()).toEqual(images.map((i) => i.key).sort());
    expect(b.copied.sort()).toEqual(a.copied);
  });
});
