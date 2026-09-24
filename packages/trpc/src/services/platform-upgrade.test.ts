import { describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { buildPlatformManifest, builtInManifest, type PlatformManifest } from '@swarmy/core/platform-manifest';
import { signPlatformManifest } from '@swarmy/core/platform-verify';
import type { SystemImage } from '@swarmy/core/system-images';
import {
  STEP_ORDER,
  controllerStepDecision,
  digestOf,
  driveRun,
  newRunState,
  parseUpdateOutput,
  planSystemUpdates,
  repoOf,
  retryRun,
  serviceUpdateScript,
  updateLanded,
  type StepHandlers,
  type StepKey,
} from './platform-upgrade.plan';
import { checkFeed, getReleaseView, shouldAutoApply, type AvailableRelease, type PlatformPolicy } from './platform-release.service';
import { pinSystemImages } from './system-images.service';
import { drivePlatformUpgrade, type PlatformUpgradeDeps } from './platform-upgrade.service';

const D = (c: string) => `sha256:${c.repeat(64)}`;
const now = () => new Date('2026-09-24T10:00:00Z');

// ── the pure step engine ─────────────────────────────────────────────────────

function recorder(over: Partial<Record<StepKey, Partial<StepHandlers[StepKey]>>> = {}) {
  const calls: string[] = [];
  const handlers = Object.fromEntries(
    STEP_ORDER.map((k) => [
      k,
      {
        run: async () => {
          calls.push(`run:${k}`);
          return { status: 'done' as const };
        },
        ...over[k],
      },
    ]),
  ) as StepHandlers;
  return { calls, handlers };
}

describe('driveRun — ordering', () => {
  it('runs preflight → controller → agents → system → engines → verify, in order, once', async () => {
    const { calls, handlers } = recorder();
    const run = newRunState();
    const saves: string[] = [];
    expect(await driveRun(run, handlers, async (r) => void saves.push(`${r.step}:${r.status}`), now)).toBe('done');
    expect(calls).toEqual(STEP_ORDER.map((k) => `run:${k}`));
    expect(run.status).toBe('done');
    expect(run.steps.every((s) => s.status === 'done')).toBe(true);
    expect(saves.at(-1)).toBe('verify:done');
    // Idle once done: a resume never re-runs anything.
    expect(await driveRun(run, handlers, async () => undefined, now)).toBe('idle');
    expect(calls.length).toBe(STEP_ORDER.length);
  });

  it('a skipped step counts as finished', async () => {
    const { calls, handlers } = recorder({ engines: { run: async () => ({ status: 'skipped', detail: 'no store' }) } });
    const run = newRunState();
    await driveRun(run, handlers, async () => undefined, now);
    expect(run.steps.find((s) => s.key === 'engines')).toMatchObject({ status: 'skipped', detail: 'no store' });
    expect(calls).not.toContain('run:engines');
  });
});

describe('driveRun — resume', () => {
  it('a waiting step returns; the next drive re-enters it with its data and never repeats finished steps', async () => {
    let restarted = false;
    const { calls, handlers } = recorder({
      controller: {
        run: async (c) => {
          calls.push('run:controller');
          const d = (c.step.data ??= {}) as { dispatched?: boolean };
          if (!d.dispatched) {
            d.dispatched = true;
            return { status: 'wait', detail: 'replacing the controller' };
          }
          return restarted ? { status: 'done' } : { status: 'wait' };
        },
      },
    });
    // Persist through JSON, like the DB row, so nothing in-memory leaks across the "restart".
    let stored = JSON.stringify(newRunState());
    const persist = async (r: unknown) => void (stored = JSON.stringify(r));
    expect(await driveRun(JSON.parse(stored), handlers, persist, now)).toBe('waiting');
    expect(JSON.parse(stored)).toMatchObject({ status: 'running', step: 'controller' });
    expect(JSON.parse(stored).steps[1]).toMatchObject({ status: 'waiting', data: { dispatched: true } });

    // Old process still alive: still waiting.
    expect(await driveRun(JSON.parse(stored), handlers, persist, now)).toBe('waiting');
    // "New controller": load from the row and carry on.
    restarted = true;
    expect(await driveRun(JSON.parse(stored), handlers, persist, now)).toBe('done');
    expect(calls.filter((c) => c === 'run:preflight')).toHaveLength(1);
    expect(calls.filter((c) => c === 'run:controller')).toHaveLength(3);
    expect(calls.slice(-4)).toEqual(['run:agents', 'run:system', 'run:engines', 'run:verify']);
  });
});

describe('driveRun — failure and rollback', () => {
  it('a failing step runs its own rollback, halts the run with a plain reason, and later steps never run', async () => {
    const rolledBack: string[] = [];
    const { calls, handlers } = recorder({
      system: {
        run: async (c) => {
          (c.step.data ??= {}).updated = ['swarmy-dns'];
          throw new Error('swarmy-ingress-caddy did not come up healthy');
        },
        rollback: async (c, reason) => {
          rolledBack.push(`${(c.step.data?.updated as string[]).join(',')} because ${reason}`);
          return 'restored swarmy-dns';
        },
      },
    });
    const run = newRunState();
    expect(await driveRun(run, handlers, async () => undefined, now)).toBe('failed');
    expect(run.status).toBe('failed');
    expect(run.step).toBe('system');
    expect(run.error).toBe('System services: swarmy-ingress-caddy did not come up healthy');
    expect(run.steps.find((s) => s.key === 'system')?.status).toBe('rolled-back');
    expect(rolledBack).toEqual(['swarmy-dns because swarmy-ingress-caddy did not come up healthy']);
    expect(calls).not.toContain('run:engines');
    expect(calls).not.toContain('run:verify');
    expect(run.log.some((l) => /rolled back: restored swarmy-dns/.test(l.msg))).toBe(true);
  });

  it('a step without a rollback is marked failed; a rollback that throws is logged, never swallowed silently', async () => {
    const a = recorder({ preflight: { run: async () => Promise.reject(new Error('node-2 offline')) } });
    const run = newRunState();
    await driveRun(run, a.handlers, async () => undefined, now);
    expect(run.steps[0]).toMatchObject({ status: 'failed', error: 'node-2 offline' });
    expect(a.calls).toEqual([]);

    const b = recorder({
      agents: { run: async () => Promise.reject(new Error('x')), rollback: async () => Promise.reject(new Error('node gone')) },
    });
    const r2 = newRunState();
    await driveRun(r2, b.handlers, async () => undefined, now);
    expect(r2.steps.find((s) => s.key === 'agents')?.status).toBe('failed');
    expect(r2.log.some((l) => l.msg.includes('ROLLBACK FAILED: node gone'))).toBe(true);
  });

  it('retry re-arms the failed step with its data kept and continues from there', async () => {
    let attempt = 0;
    const { calls, handlers } = recorder({
      agents: {
        run: async (c) => {
          calls.push('run:agents');
          const d = (c.step.data ??= {}) as { nodes?: string[] };
          d.nodes = [...(d.nodes ?? []), `try${++attempt}`];
          if (attempt === 1) throw new Error('node-3 did not reconnect');
          return { status: 'done' };
        },
      },
    });
    const run = newRunState();
    await driveRun(run, handlers, async () => undefined, now);
    expect(() => retryRun(newRunState())).toThrow(/only a failed run/);
    retryRun(run, now);
    expect(run).toMatchObject({ status: 'running', step: 'agents', error: null });
    expect(await driveRun(run, handlers, async () => undefined, now)).toBe('done');
    expect(run.steps.find((s) => s.key === 'agents')?.data).toEqual({ nodes: ['try1', 'try2'] });
    expect(calls.filter((c) => c === 'run:preflight')).toHaveLength(1);
  });
});

// ── controller step decision ─────────────────────────────────────────────────

describe('controllerStepDecision', () => {
  const T = D('b');
  const base = { target: T, inventoryReady: true, processStartedAt: 1_000, now: 2_000 };
  it('dispatches when the live controller is not on the target; done when it already is', () => {
    expect(controllerStepDecision({ ...base, liveImage: `ghcr.io/x/c:1@${D('a')}` })).toEqual({ action: 'dispatch' });
    expect(controllerStepDecision({ ...base, liveImage: `ghcr.io/x/c@${T}` }).action).toBe('done');
  });
  it('skips when there is no controller service (dev) but waits while the hub is still warming up', () => {
    expect(controllerStepDecision({ ...base, liveImage: undefined }).action).toBe('skip');
    expect(controllerStepDecision({ ...base, liveImage: undefined, inventoryReady: false }).action).toBe('wait');
    expect(controllerStepDecision({ ...base, target: null, liveImage: 'x' }).action).toBe('skip');
  });
  it('after dispatch: the old process waits; the NEW process (started later) on the target is done', () => {
    const dispatchedAt = new Date(1_500).toISOString();
    expect(controllerStepDecision({ ...base, dispatchedAt, liveImage: `c@${T}`, processStartedAt: 1_000 }).action).toBe('wait');
    expect(controllerStepDecision({ ...base, dispatchedAt, liveImage: `c@${T}`, processStartedAt: 1_600 }).action).toBe('done');
    // Commit match is enough when the spec is tag-only.
    expect(
      controllerStepDecision({ ...base, dispatchedAt, liveImage: 'c:edge', processStartedAt: 1_600, selfCommit: 'n', targetCommit: 'n', fromCommit: 'o' }).action,
    ).toBe('done');
  });
  it('Swarm rolled the controller back → fail; never replaced → fail after the timeout', () => {
    const dispatchedAt = new Date(1_500).toISOString();
    expect(controllerStepDecision({ ...base, dispatchedAt, liveImage: `c@${D('a')}`, processStartedAt: 1_600 }).action).toBe('fail');
    expect(controllerStepDecision({ ...base, dispatchedAt, liveImage: `c@${T}`, liveUpdateState: 'rollback_started' }).action).toBe('fail');
    expect(controllerStepDecision({ ...base, dispatchedAt, liveImage: `c@${D('a')}`, now: 1_500 + 16 * 60_000 }).action).toBe('fail');
    expect(controllerStepDecision({ ...base, dispatchedAt, liveImage: undefined, processStartedAt: 1_600 }).action).toBe('wait');
  });
});

// ── system services plan + scripts ───────────────────────────────────────────

describe('planSystemUpdates', () => {
  const m = buildPlatformManifest({
    version: '1.3.0',
    channel: 'stable',
    commit: 'n',
    digests: { dns: D('d'), caddySwarmy: D('e'), controller: D('b'), agent: D('f') },
  });
  const resolve = (_k: string, c: { image: string; digest?: string }) => `${c.image}@${c.digest}`;
  it('orders DNS → edges → observability, skips up-to-date, controller, Garage, registry and user services', () => {
    const services = [
      { name: 'swarmy-otel-collector', image: 'otel/opentelemetry-collector-contrib:0.111.0' },
      { name: 'swarmy-ingress-caddy', image: 'localhost:5000/swarmy-system/ghcr.io/requestflo/caddy-swarmy@' + D('1') },
      { name: 'swarmy-dns', image: 'ghcr.io/requestflo/swarmy-dns:latest@' + D('2') },
      { name: 'swarmy_controller', image: 'ghcr.io/requestflo/swarmy-controller:latest' },
      { name: 'swarmy-garage', image: 'dxflrs/garage:v1.0.1' },
      { name: 'swarmy-registry', image: 'registry:2' },
      { name: 'swarmy-clickhouse', image: `docker.io/clickhouse/clickhouse-server@${m.components.clickhouse!.digest}` },
      { name: 'my-cache', image: 'valkey/valkey:8' },
    ];
    const plan = planSystemUpdates(services, m.components, resolve);
    expect(plan.map((p) => p.service)).toEqual(['swarmy-dns', 'swarmy-ingress-caddy', 'swarmy-otel-collector']);
    expect(plan[0]!.to).toBe(`ghcr.io/requestflo/swarmy-dns@${D('d')}`);
  });
  it('repoOf normalises tags, digests, mirror prefixes and Hub shorthands', () => {
    expect(repoOf('localhost:5000/swarmy-system/ghcr.io/requestflo/swarmy-dns:latest@' + D('1'))).toBe('ghcr.io/requestflo/swarmy-dns');
    expect(repoOf('registry:2')).toBe('docker.io/library/registry');
    expect(repoOf('otel/opentelemetry-collector-contrib:0.1')).toBe('docker.io/otel/opentelemetry-collector-contrib');
    expect(digestOf(`x@${D('a')}`)).toBe(D('a'));
    expect(digestOf('x:1')).toBeNull();
  });
  it('update script: rollback-on-failure, detached for the controller, creds from env only', () => {
    const s = serviceUpdateScript('swarmy_controller', `c@${D('b')}`, { detach: true, login: 'localhost:5000' });
    expect(s).toContain('--update-failure-action rollback');
    expect(s).toContain('--detach ');
    expect(s).toContain('"$SWARMY_REG_PASS"');
    expect(serviceUpdateScript('swarmy-dns', 'x')).toContain('--detach=false');
    expect(parseUpdateOutput('noise\n@@SWARMY-UPDATE@@ 0 completed\n')).toEqual({ rc: 0, state: 'completed' });
    expect(updateLanded({ rc: 0, state: 'completed' })).toBe(true);
    expect(updateLanded({ rc: 0, state: 'rollback_completed' })).toBe(false);
    expect(updateLanded(parseUpdateOutput('crash'))).toBe(false);
  });
});

// ── auto-apply policy ────────────────────────────────────────────────────────

describe('shouldAutoApply', () => {
  const policy: PlatformPolicy = { channel: 'stable', feedUrl: null, autoApplyPatches: true, window: { days: [4], startHour: 9, hours: 2 } };
  const rel = (version: string, verified = true): AvailableRelease => ({
    manifest: buildPlatformManifest({ version, channel: 'stable', commit: '' }),
    signature: 's',
    verified,
    source: 'feed',
    fetchedAt: '',
  });
  const base = { policy, current: '1.2.3', available: rel('1.2.4'), running: false, lastFailedTarget: null, now: now() }; // Thu 10:00 UTC
  it('patch + verified + in window → go', () => expect(shouldAutoApply(base)).toEqual({ go: true, version: '1.2.4' }));
  it('never a minor/major, unverified, outside the window, off, while running, or a target that already failed', () => {
    expect(shouldAutoApply({ ...base, available: rel('1.3.0') }).go).toBe(false);
    expect(shouldAutoApply({ ...base, available: rel('1.2.4', false) }).go).toBe(false);
    expect(shouldAutoApply({ ...base, now: new Date('2026-09-24T12:00:00Z') }).go).toBe(false);
    expect(shouldAutoApply({ ...base, policy: { ...policy, autoApplyPatches: false } }).go).toBe(false);
    expect(shouldAutoApply({ ...base, running: true }).go).toBe(false);
    expect(shouldAutoApply({ ...base, lastFailedTarget: '1.2.4' }).go).toBe(false);
  });
});

// ── the service: a whole run, the controller restart in the middle ───────────

describe('drivePlatformUpgrade (service over fakes)', () => {
  const kp = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const priv = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  process.env.SWARMY_RELEASE_PUBKEY = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();

  const OLD = D('a');
  const NEW = D('b');
  const BOM: SystemImage[] = [{ key: 'controller', ref: 'ghcr.io/requestflo/swarmy-controller:latest' }];

  function world(target: PlatformManifest, from: PlatformManifest) {
    let controllerImage = `ghcr.io/requestflo/swarmy-controller@${OLD}`;
    let agentCommit = 'old';
    const dispatched: Array<{ cmd: string; payload: any }> = [];
    let runRow: any = {
      id: 'run1',
      orgId: 'org_1',
      status: 'running',
      step: 'preflight',
      fromVersion: from.version,
      toVersion: target.version,
      trigger: 'manual',
      actorId: null,
      manifest: target,
      signature: signPlatformManifest(target, priv),
      fromManifest: from,
      steps: newRunState().steps,
      options: { skipBackup: false },
      error: null,
      log: [],
      startedAt: new Date(),
      finishedAt: null,
    };
    let currentManifest: unknown = null;
    const ctx: any = {
      activeOrgId: 'org_1',
      user: null,
      db: {
        platformUpgradeRun: {
          findFirst: async () => JSON.parse(JSON.stringify({ ...runRow, startedAt: undefined })),
          update: async ({ data }: any) => (runRow = { ...runRow, ...JSON.parse(JSON.stringify(data)) }),
        },
        node: { findMany: async () => [{ id: 'n1', name: 'node-1' }, { id: 'n2', name: 'node-2' }] },
        platformConfig: {
          upsert: async () => ({ orgId: 'org_1' }),
          update: async ({ data }: any) => (currentManifest = data.currentManifest),
        },
        registryConfig: { findUnique: async () => null },
      },
      hub: {
        isOnline: () => true,
        managerNode: () => 'n1',
        nodeInventory: () => [{ role: 'manager', status: 'ready', reachability: 'reachable' }],
        latestNodeStats: () => ({ fsUsedBytes: 1, fsTotalBytes: 100 * 1024 ** 3 }),
        liveInventory: () => ({
          services: [{ name: 'swarmy_controller', image: controllerImage, runningReplicas: 1, desiredReplicas: 1, labels: {} }],
          containers: [],
        }),
        agentBuildFor: () => ({ version: '1.3.0', commit: agentCommit, packaging: 'container' }),
        dispatch: async (_node: string, cmd: string, payload: any) => {
          dispatched.push({ cmd, payload });
          return { exitCode: 0, output: '@@SWARMY-UPDATE@@ 0 updating' };
        },
      },
    };
    const agentUpgrades: string[] = [];
    const deps = (processStartedAt: number): PlatformUpgradeDeps => ({
      controllerBackup: async () => ({ snapshotId: 'snap1' }),
      mirror: async () => ({ copied: ['controller'], failed: [] }),
      upgradeAgent: async (_c, id, image) => {
        agentUpgrades.push(`${id} ${image}`);
        agentCommit = 'new';
      },
      agentRelease: () => ({ version: '1.3.0', commit: 'new' }),
      engine: { available: async () => null, start: async () => ({ id: 'x' }), read: async () => null },
      audit: async () => undefined,
      sleep: async () => undefined,
      now: () => new Date(),
      processStartedAt,
      self: () => ({ version: '1.3.0', commit: 'n' }),
      pollMs: 1,
    });
    return {
      ctx,
      deps,
      dispatched,
      agentUpgrades,
      row: () => runRow,
      currentManifest: () => currentManifest,
      swarmReplacesController: (image: string) => (controllerImage = image),
    };
  }

  it('backs up, replaces the controller, RESUMES in the new process, rolls agents one by one, records the release', async () => {
    const from = builtInManifest('1.2.0', 'o', BOM);
    const target = buildPlatformManifest({ version: '1.3.0', channel: 'stable', commit: 'n', digests: { controller: NEW, agent: D('f') } });
    const w = world(target, from);

    // Old controller: preflight, then dispatch the controller update and wait.
    await drivePlatformUpgrade(w.ctx, 'run1', w.deps(0));
    expect(w.row()).toMatchObject({ status: 'running', step: 'controller' });
    expect(w.row().steps[0]).toMatchObject({ status: 'done', data: { backupSnapshotId: 'snap1', mirrored: true } });
    const update = w.dispatched.find((d) => d.cmd === 'container.runOnce');
    expect(update?.payload.binds).toEqual(['/var/run/docker.sock:/var/run/docker.sock']);
    expect(update?.payload.cmd[0]).toContain(`--image 'ghcr.io/requestflo/swarmy-controller@${NEW}'`);
    expect(update?.payload.cmd[0]).toContain('--update-failure-action rollback');

    // Swarm stops the old process and starts the new image; the NEW process resumes.
    w.swarmReplacesController(`ghcr.io/requestflo/swarmy-controller@${NEW}`);
    await drivePlatformUpgrade(w.ctx, 'run1', w.deps(Date.now() + 1_000));
    expect(w.row().status).toBe('done');
    expect(w.row().steps.map((s: any) => `${s.key}:${s.status}`)).toEqual([
      'preflight:done',
      'controller:done',
      'agents:done',
      'system:done',
      'engines:skipped',
      'verify:done',
    ]);
    expect(w.agentUpgrades[0]).toBe(`n1 ghcr.io/requestflo/swarmy-agent@${D('f')}`);
    expect((w.currentManifest() as PlatformManifest).version).toBe('1.3.0');
    // Exactly one controller replacement across both processes.
    expect(w.dispatched.filter((d) => d.cmd === 'container.runOnce').length).toBe(1);
  });

  it('a new controller that Swarm rolled back fails the controller step with a plain reason', async () => {
    const from = builtInManifest('1.2.0', 'o', BOM);
    const target = buildPlatformManifest({ version: '1.3.0', channel: 'stable', commit: 'n', digests: { controller: NEW } });
    const w = world(target, from);
    await drivePlatformUpgrade(w.ctx, 'run1', w.deps(0));
    // Restart, but Swarm put the OLD digest back (new task unhealthy).
    const d = w.deps(Date.now() + 1_000);
    await drivePlatformUpgrade(w.ctx, 'run1', { ...d, self: () => ({ version: '1.2.0', commit: 'o' }) });
    expect(w.row()).toMatchObject({ status: 'failed', step: 'controller' });
    expect(w.row().error).toMatch(/Swarm rolled back/);
  });

  it('refuses a tampered release at preflight (signature re-verified on every drive)', async () => {
    const from = builtInManifest('1.2.0', 'o', BOM);
    const target = buildPlatformManifest({ version: '1.3.0', channel: 'stable', commit: 'n', digests: { controller: NEW } });
    const w = world(target, from);
    w.row().manifest = { ...target, components: { ...target.components, controller: { ...target.components.controller!, digest: D('9') } } };
    await drivePlatformUpgrade(w.ctx, 'run1', w.deps(0));
    expect(w.row()).toMatchObject({ status: 'failed', step: 'preflight' });
    expect(w.row().error).toMatch(/unverified release/);
    expect(w.dispatched).toHaveLength(0);
  });
});

// ── deploy by digest + feed verification ─────────────────────────────────────

describe('pinSystemImages (no floating tags in running system services)', () => {
  const imgs: SystemImage[] = [
    { key: 'dns', ref: 'ghcr.io/requestflo/swarmy-dns:latest', digest: D('d') },
    { key: 'registry', ref: 'registry:2', digest: D('a'), noRewrite: true },
    { key: 'agent', ref: 'ghcr.io/requestflo/swarmy-agent:latest' },
  ];
  it('pins an exact system ref with a release digest; leaves others, the registry and one-shots alone', () => {
    const deploy = (image: string) => ({ spec: { name: 's', image } });
    expect(pinSystemImages('service.deploy', deploy('ghcr.io/requestflo/swarmy-dns:latest'), imgs).spec.image).toBe(
      `ghcr.io/requestflo/swarmy-dns@${D('d')}`,
    );
    expect(pinSystemImages('service.deploy', deploy('registry:2'), imgs).spec.image).toBe('registry:2');
    expect(pinSystemImages('service.deploy', deploy('ghcr.io/requestflo/swarmy-agent:latest'), imgs).spec.image).toBe(
      'ghcr.io/requestflo/swarmy-agent:latest',
    );
    expect(pinSystemImages('service.deploy', deploy('nginx:1'), imgs).spec.image).toBe('nginx:1');
    const once = { image: 'ghcr.io/requestflo/swarmy-dns:latest' };
    expect(pinSystemImages('container.runOnce', once, imgs)).toBe(once);
  });
});

describe('checkFeed (signed feed, offline verification)', () => {
  const kp = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const priv = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  function db(channel = 'stable') {
    let row: any = { id: 'pc1', orgId: 'org_1', channel, feedUrl: 'https://mirror.lan/swarmy', autoApplyPatches: false, window: null, currentManifest: null, available: null, lastCheckAt: null, lastCheckError: null };
    return {
      get row() {
        return row;
      },
      platformConfig: {
        upsert: async () => row,
        findUnique: async () => row,
        update: async ({ data }: any) => (row = { ...row, ...JSON.parse(JSON.stringify(data)), lastCheckAt: data.lastCheckAt ?? row.lastCheckAt }),
      },
    };
  }
  it('stores a verified release from <feed>/<channel>/platform.json(.sig); the view offers it', async () => {
    process.env.SWARMY_RELEASE_PUBKEY = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const m = buildPlatformManifest({ version: '99.0.0', channel: 'stable', commit: 'n', notes: [{ kind: 'new', text: 'Time travel' }] });
    const fetched: string[] = [];
    const d = db();
    const rel = await checkFeed({ db: d as never, activeOrgId: 'org_1' }, async (url) => {
      fetched.push(url);
      return url.endsWith('.sig') ? signPlatformManifest(m, priv) : JSON.stringify(m);
    });
    expect(fetched.sort()).toEqual(['https://mirror.lan/swarmy/stable/platform.json', 'https://mirror.lan/swarmy/stable/platform.json.sig']);
    expect(rel?.verified).toBe(true);
    const view = await getReleaseView({ db: d as never, activeOrgId: 'org_1' });
    expect(view.available).toMatchObject({ version: '99.0.0', verified: true, blocked: null });
    expect(view.available?.notes[0]?.text).toBe('Time travel');
  });
  it('an unsigned / foreign-signed release is stored as unverified and Upgrade stays disabled', async () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const m = buildPlatformManifest({ version: '99.0.0', channel: 'stable', commit: 'n' });
    const d = db();
    const rel = await checkFeed({ db: d as never, activeOrgId: 'org_1' }, async (url) => (url.endsWith('.sig') ? signPlatformManifest(m, other) : JSON.stringify(m)));
    expect(rel?.verified).toBe(false);
    const view = await getReleaseView({ db: d as never, activeOrgId: 'org_1' });
    expect(view.available?.blocked).toMatch(/unverified release/);
  });
  it('a release from the other channel is refused; a feed outage keeps the last result and records the error', async () => {
    const m = buildPlatformManifest({ version: '99.0.0', channel: 'edge', commit: 'n' });
    const d = db('stable');
    const rel = await checkFeed({ db: d as never, activeOrgId: 'org_1' }, async (url) => (url.endsWith('.sig') ? signPlatformManifest(m, priv) : JSON.stringify(m)));
    expect(rel).toMatchObject({ verified: false, reason: expect.stringMatching(/edge release on the stable channel/) });
    await checkFeed({ db: d as never, activeOrgId: 'org_1' }, async () => {
      throw new Error('ENOTFOUND');
    });
    expect(d.row.lastCheckError).toBe('ENOTFOUND');
    expect(d.row.available).toBeTruthy();
  });
});
