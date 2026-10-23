import { describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { buildPlatformManifest } from '@swarmy/core/platform-manifest';
import { signPlatformManifest } from '@swarmy/core/platform-verify';
import { STEP_ORDER, newRunState } from './platform-upgrade.plan';
import { REVERSIBLE_STEPS } from './platform-upgrade.pause';
import { buildHandlers, drivePlatformUpgrade, type PlatformUpgradeDeps } from './platform-upgrade.service';
import { abandonPlatformUpgrade, requestPlatformPause, resumePlatformUpgrade } from './platform-upgrade-control.service';

const D = (c: string) => `sha256:${c.repeat(64)}`;
const kp = generateKeyPairSync('ec', { namedCurve: 'P-256' });
process.env.SWARMY_RELEASE_PUBKEY = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const priv = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const CTRL = 'ghcr.io/requestflo/swarmy-controller';
const DNS = 'ghcr.io/requestflo/swarmy-dns';

/** One org, two servers, the controller + swarmy-dns as live services; the run row round-trips like the DB. */
function world() {
  const from = buildPlatformManifest({ version: '1.2.4', channel: 'stable', commit: 'o', digests: { controller: D('a'), agent: D('e'), dns: D('c') } });
  const target = buildPlatformManifest({ version: '1.3.0', channel: 'stable', commit: 'n', digests: { controller: D('b'), agent: D('f'), dns: D('d') } });
  const img = { controller: `${CTRL}@${D('a')}`, dns: `${DNS}@${D('c')}` };
  const agentCommit: Record<string, string> = { n1: 'old', n2: 'old' };
  let pauseDuringSystem = false;
  const dispatched: Array<{ cmd: string; payload: any }> = [];
  const audit: string[] = [];
  let row: any = {
    id: 'run1', orgId: 'org_1', status: 'running', step: 'preflight', fromVersion: '1.2.4', toVersion: '1.3.0', trigger: 'manual',
    actorId: null, manifest: target, signature: signPlatformManifest(target, priv), fromManifest: from, steps: newRunState().steps,
    options: { skipBackup: false }, error: null, log: [], startedAt: new Date(), finishedAt: null,
  };
  const runs = {
    findFirst: async ({ where }: any) =>
      where?.NOT?.id === row.id || (where?.status?.in && !where.status.in.includes(row.status)) ? null : structuredClone(row),
    update: async ({ data }: any) => (row = { ...row, ...structuredClone(data) }),
  };
  const ctx: any = {
    activeOrgId: 'org_1',
    user: { id: 'u1' },
    db: {
      platformUpgradeRun: runs,
      node: { findMany: async () => [{ id: 'n1', name: 'node-1' }, { id: 'n2', name: 'node-2' }] },
      platformConfig: { upsert: async () => ({ orgId: 'org_1' }), update: async () => ({}) },
      registryConfig: { findUnique: async () => null, findFirst: async () => null },
    },
    hub: {
      isOnline: () => true,
      managerNode: () => 'n1',
      nodeInventory: () => [{ role: 'manager', status: 'ready', reachability: 'reachable' }],
      latestNodeStats: () => ({ fsUsedBytes: 1, fsTotalBytes: 100 * 1024 ** 3 }),
      liveInventory: () => ({
        services: [
          { name: 'swarmy_controller', image: img.controller, runningReplicas: 1, desiredReplicas: 1, labels: {} },
          { name: 'swarmy-dns', image: img.dns, runningReplicas: 1, desiredReplicas: 1, labels: {} },
        ],
        containers: [],
      }),
      agentBuildFor: (id: string) => ({ version: '1.3.0', commit: agentCommit[id], packaging: 'container' }),
      dispatch: async (_n: string, cmd: string, payload: any) => {
        dispatched.push({ cmd, payload });
        const m = /--image '([^']+)'.* '(swarmy-dns)'; RC/.exec(payload?.cmd?.[0] ?? '');
        if (m) {
          img.dns = m[1]!;
          if (pauseDuringSystem) row.options = { ...row.options, pauseRequestedAt: new Date().toISOString() };
        }
        return { exitCode: 0, output: '@@SWARMY-UPDATE@@ 0 completed' };
      },
    },
  };
  const deps = (processStartedAt: number): PlatformUpgradeDeps => ({
    controllerBackup: async () => ({ snapshotId: 'snap1' }),
    mirror: async () => ({ copied: [], failed: [] }),
    upgradeAgent: async (_c, id) => void (agentCommit[id] = 'new'),
    agentRelease: () => ({ version: '1.3.0', commit: 'new' }),
    engine: { available: async () => null, start: async () => ({ id: 'x' }), read: async () => null },
    audit: async (_c, e) => void audit.push(e.action),
    sleep: async () => undefined,
    now: () => new Date(),
    processStartedAt,
    self: () => ({ version: '1.3.0', commit: 'n' }),
    pollMs: 1,
  });
  const steps = () => row.steps.map((s: any) => `${s.key}:${s.status}`).join(' ');
  return { ctx, deps, img, row: () => row, steps, dispatched, audit, agentCommits: () => Object.values(agentCommit), pauseInSystem: () => void (pauseDuringSystem = true) };
}

const settle = () => Bun.sleep(20);

describe('pause after this step — across the controller replacing itself', () => {
  it('asked while the old controller waits; the NEW one finishes that step, pauses, then resumes to done', async () => {
    const w = world();
    await drivePlatformUpgrade(w.ctx, 'run1', w.deps(0));
    expect(w.row()).toMatchObject({ status: 'running', step: 'controller' });
    const v = await requestPlatformPause(w.ctx, { id: 'run1', pause: true }, w.deps(0));
    expect(v.pause?.by).toBe('u1');

    w.img.controller = `${CTRL}@${D('b')}`; // Swarm swapped the image; this is the new process:
    await drivePlatformUpgrade(w.ctx, 'run1', w.deps(Date.now() + 1_000));
    expect(w.row()).toMatchObject({ status: 'paused', step: 'agents', finishedAt: null });
    expect(w.agentCommits()).toEqual(['old', 'old']);
    expect(w.audit).toEqual(['platform.upgrade.pause', 'platform.upgrade.paused']);
    await expect(requestPlatformPause(w.ctx, { id: 'run1', pause: true }, w.deps(0))).rejects.toThrow(/only a running upgrade/);

    const r = await resumePlatformUpgrade(w.ctx, 'run1', w.deps(Date.now() + 1_000));
    expect(r.pause).toBeNull();
    await settle();
    expect(w.row().status).toBe('done');
    expect(w.img.dns).toBe(`${DNS}@${D('d')}`);
  });
});

describe('abandon a paused run', () => {
  it('puts swarmy-dns back on its exact old image and the agents on the old digest; the controller stays', async () => {
    const w = world();
    w.pauseInSystem();
    await drivePlatformUpgrade(w.ctx, 'run1', w.deps(0));
    w.img.controller = `${CTRL}@${D('b')}`;
    await drivePlatformUpgrade(w.ctx, 'run1', w.deps(Date.now() + 1_000));
    expect(w.row()).toMatchObject({ status: 'paused', step: 'engines' });
    expect(w.steps()).toBe('preflight:done controller:done agents:done system:done engines:pending verify:pending');

    await abandonPlatformUpgrade(w.ctx, 'run1', w.deps(Date.now() + 1_000));
    await settle();
    expect(w.row().status).toBe('abandoned');
    expect(w.row().finishedAt).toBeInstanceOf(Date);
    expect(w.steps()).toBe('preflight:done controller:done agents:rolled-back system:rolled-back engines:pending verify:pending');
    expect(w.img.dns).toBe(`${DNS}@${D('c')}`);
    expect(w.img.controller).toBe(`${CTRL}@${D('b')}`);
    const back = w.dispatched.filter((d) => d.cmd === 'agent.update').map((d) => d.payload.image);
    expect(back).toEqual([`ghcr.io/requestflo/swarmy-agent@${D('e')}`, `ghcr.io/requestflo/swarmy-agent@${D('e')}`]);
    expect(w.audit.slice(-2)).toEqual(['platform.upgrade.abandon', 'platform.upgrade.abandoned']);
    // Health-gated on the way back too.
    const restore = w.dispatched.filter((d) => d.cmd === 'container.runOnce').at(-1)!.payload.cmd[0] as string;
    expect(restore).toContain(`--image '${DNS}@${D('c')}'`);
    expect(restore).toContain('--update-failure-action rollback');
  });

  it('REVERSIBLE_STEPS is exactly the steps whose handlers can put themselves back', () => {
    const w = world();
    const h = buildHandlers(w.ctx, w.row(), w.deps(0));
    expect(STEP_ORDER.filter((k) => h[k].abandon ?? h[k].rollback)).toEqual([...REVERSIBLE_STEPS]);
  });
});
