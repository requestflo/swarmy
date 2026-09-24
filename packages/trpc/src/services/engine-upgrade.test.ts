import { beforeEach, describe, expect, it } from 'bun:test';
import {
  backupVolumeFor,
  copyVolumePayload,
  engineUpgradeAvailable,
  getEngineUpgrade,
  stageCopyImagePayload,
  startEngineUpgrade,
  GARAGE_META_VOLUME,
} from './engine-upgrade.service';

// ── fakes for the store's admin API + redeploy (injected seams) ──────────────
let health: Array<{ status: string; connectedNodes: number }> = [];
let buckets: Array<{ id: string; objects: number }> = [];
let bucketsAfter: Array<{ id: string; objects: number }> | null = null;
const deployedImages: string[] = [];
let engineImage: string | null = null;
const calls: string[] = [];

const deps = {
  admin: async (_ctx: unknown, major: 1 | 2, call: { method: string; path: string }) => {
    calls.push(`v${major} ${call.method} ${call.path}`);
    const list = major === 2 && bucketsAfter ? bucketsAfter : buckets;
    if (call.path === '/health') return JSON.stringify(health.shift() ?? { status: 'healthy', connectedNodes: 3 });
    if (call.path === '/bucket?list') return JSON.stringify(list.map((b) => ({ id: b.id })));
    const id = decodeURIComponent(call.path.split('id=')[1] ?? '');
    return JSON.stringify({ id, objects: list.find((b) => b.id === id)?.objects ?? 0 });
  },
  redeploy: async () => {
    deployedImages.push(engineImage ?? 'dxflrs/garage:v1.0.1');
    return {};
  },
  audit: async () => undefined,
  pollMs: 1,
} as never;



function world(opts: { copyFailsOn?: string; stageFailsOn?: string } = {}) {
  let row: Record<string, unknown> = {
    id: 'sc1',
    orgId: 'org_1',
    enabled: true,
    engineImage: null,
    memberNodeIds: ['n1', 'n2', 'n3'],
    engineUpgrade: null,
  };
  let storeTasks = 3;
  const dispatched: Array<{ node: string; cmd: string; payload: any }> = [];
  const ctx = {
    activeOrgId: 'org_1',
    db: {
      storageCluster: {
        findUnique: async () => ({ ...row, engineImage }),
        update: async ({ data }: { data: Record<string, unknown> }) => {
          if ('engineImage' in data) engineImage = data.engineImage as string | null;
          row = { ...row, ...data };
          return row;
        },
      },
    },
    hub: {
      isOnline: () => true,
      managerNode: () => 'n1',
      liveInventory: () => ({
        services: [],
        containers: Array.from({ length: storeTasks }, (_, i) => ({ name: `/swarmy-garage.${i}.x` })),
      }),
      dispatch: async (node: string, cmd: string, payload: any) => {
        dispatched.push({ node, cmd, payload });
        if (cmd === 'service.remove') storeTasks = 0;
        if (cmd === 'container.runOnce') {
          if (!payload.binds) {
            // Image staging (preflight): a member that can't pull fails it.
            return opts.stageFailsOn === node ? { exitCode: 125, output: 'No such image' } : { exitCode: 0, output: '' };
          }
          if (opts.copyFailsOn === node && payload.binds[0].startsWith(GARAGE_META_VOLUME + ':')) {
            return { exitCode: 1, output: 'disk full' };
          }
          return { exitCode: 0, output: 'copied 812' };
        }
        return {};
      },
    },
  };
  return { ctx: ctx as any, dispatched, row: () => row };
}

async function settle(w: ReturnType<typeof world>) {
  for (let i = 0; i < 200; i++) {
    const run = w.row().engineUpgrade as { status?: string } | null;
    if (run && run.status !== 'running') return run as any;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('run did not finish');
}

beforeEach(() => {
  health = [];
  buckets = [
    { id: 'b1', objects: 21 },
    { id: 'b2', objects: 3 },
  ];
  bucketsAfter = null;
  deployedImages.length = 0;
  engineImage = null;
  calls.length = 0;
});

describe('engine upgrade — pure', () => {
  it('only offers a MAJOR upgrade from what the store runs', () => {
    expect(engineUpgradeAvailable(null, 'dxflrs/garage:v2.4.1')).toBe('dxflrs/garage:v2.4.1');
    expect(engineUpgradeAvailable('dxflrs/garage:v1.3.1', 'dxflrs/garage:v2.4.1')).toBe('dxflrs/garage:v2.4.1');
    expect(engineUpgradeAvailable('dxflrs/garage:v2.4.1', 'dxflrs/garage:v2.4.1')).toBeNull();
  });
  it('backup volume is a valid docker volume name, per run', () => {
    expect(backupVolumeFor('eu-m1abc!')).toBe('swarmy-garage-meta-backup-eum1abc');
  });
  it('the copy one-shot mounts the source read-only and runs as root', () => {
    const p = copyVolumePayload('a', 'b');
    expect(p.binds).toEqual(['a:/src:ro', 'b:/dst']);
    expect(p.user).toBe('0:0');
  });
});

describe('engine upgrade — run', () => {
  it('stops, copies metadata on EVERY member, deploys v2, verifies in the v2 dialect', async () => {
    const w = world();
    await startEngineUpgrade(w.ctx, deps);
    const run = await settle(w);
    expect(run.status).toBe('done');
    expect(engineImage).toBe('dxflrs/garage:v2.4.1');
    expect(deployedImages).toEqual(['dxflrs/garage:v2.4.1']);
    // Order: remove the service BEFORE any copy (a live copy would be torn).
    const kind = (d: { cmd: string; payload: any }) =>
      d.cmd === 'container.runOnce' ? (d.payload.binds ? 'copy' : 'stage') : d.cmd;
    const order = w.dispatched.map(kind);
    // Stage the copy image on every member BEFORE the outage…
    expect(w.dispatched.filter((d) => kind(d) === 'stage').map((d) => d.node)).toEqual(['n1', 'n2', 'n3']);
    expect(order.lastIndexOf('stage')).toBeLessThan(order.indexOf('service.remove'));
    // …and never pull mid-outage.
    expect(w.dispatched.filter((d) => kind(d) === 'copy').every((d) => d.payload.pull === false)).toBe(true);
    expect(order.indexOf('service.remove')).toBeLessThan(order.indexOf('copy'));
    expect(w.dispatched.filter((d) => kind(d) === 'copy').map((d) => d.node)).toEqual(['n1', 'n2', 'n3']);
    // Preflight speaks v1 to the old engine, verify speaks v2 to the new one.
    expect(calls[0]).toBe('v1 GET /health');
    expect(calls.some((c) => c.startsWith('v2 GET /health'))).toBe(true);
    expect((await getEngineUpgrade(w.ctx)).available).toBeNull();
  });

  it('refuses to start on an unhealthy store — nothing is stopped', async () => {
    health = [{ status: 'degraded', connectedNodes: 2 }];
    const w = world();
    await startEngineUpgrade(w.ctx, deps);
    const run = await settle(w);
    expect(run.status).toBe('failed');
    expect(run.error).toContain('degraded');
    expect(w.dispatched.some((d) => d.cmd === 'service.remove')).toBe(false);
    expect(engineImage).toBeNull();
  });

  it('a member that cannot stage the copy image fails preflight — nothing is stopped', async () => {
    const w = world({ stageFailsOn: 'n2' });
    await startEngineUpgrade(w.ctx, deps);
    const run = await settle(w);
    expect(run.status).toBe('failed');
    expect(run.error).toContain('n2');
    expect(w.dispatched.some((d) => d.cmd === 'service.remove')).toBe(false);
    expect(engineImage).toBeNull();
    expect(stageCopyImagePayload().pull).toBe(true);
  });

  it('a failed backup rolls back: restores only copied members, redeploys the OLD engine', async () => {
    const w = world({ copyFailsOn: 'n2' });
    await startEngineUpgrade(w.ctx, deps);
    const run = await settle(w);
    expect(run.status).toBe('rolled-back');
    expect(engineImage).toBeNull();
    expect(deployedImages).toEqual(['dxflrs/garage:v1.0.1']);
    const restores = w.dispatched.filter(
      (d) => d.cmd === 'container.runOnce' && d.payload.binds?.[1] === `${GARAGE_META_VOLUME}:/dst`,
    );
    expect(restores.map((d) => d.node)).toEqual(['n1']);
  });

  it('lost objects after the swap roll back to v1', async () => {
    bucketsAfter = [{ id: 'b1', objects: 20 }, { id: 'b2', objects: 3 }];
    const w = world();
    await startEngineUpgrade(w.ctx, deps);
    const run = await settle(w);
    expect(run.status).toBe('rolled-back');
    expect(run.error).toContain('object counts dropped');
    expect(deployedImages).toEqual(['dxflrs/garage:v2.4.1', 'dxflrs/garage:v1.0.1']);
    expect(engineImage).toBeNull();
  });
});
