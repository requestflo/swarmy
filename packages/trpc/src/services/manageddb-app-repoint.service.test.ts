import { describe, expect, it } from 'bun:test';
import { repointDbApps } from './manageddb-app-repoint.service';
import { injectConnection, provisionDb } from './manageddb.service';
import { CLUSTER, STACK, world } from './manageddb-testing';

/**
 * Apps follow the writer, against the stateful fake swarm: after a failover
 * a direct app gets a URL secret for the new writer (a new version, the old
 * one removed), a pooler app is never touched, a second call does nothing,
 * and a pass cut short is finished by the next one with the same secret.
 */

const P = 'shop_main-primary';
const R = 'shop_main-replica';
const PW = 'follow-the-writer-pw';

async function wired(apps: Array<{ name: string; via?: 'pooler'; mounts?: boolean }>) {
  const w = world();
  await provisionDb(w.ctx, { stack: STACK, name: CLUSTER, replicas: 1, password: PW, autoBackup: false });
  w.services.get(P)!.labels['swarmy.db.pooler'] = '{"mode":"transaction","poolSize":20}';
  for (const a of apps) {
    w.put({
      name: a.name,
      image: 'web:1',
      labels: { 'com.docker.stack.namespace': STACK },
      networks: ['shop_default'],
      ...(a.mounts ? { mounts: [{ type: 'volume', source: 'uploads', target: '/data' }] } : {}),
    });
    await injectConnection(w.ctx, { stack: STACK, cluster: CLUSTER, appService: a.name, ...(a.via ? { via: a.via } : {}) });
  }
  const calls: string[] = [];
  const audit: Array<{ action: string; metadata: Record<string, unknown> }> = [];
  const inner = w.ctx.hub.dispatch;
  let failDeployOf: string | null = null;
  (w.ctx.hub as { dispatch: unknown }).dispatch = async (n: string, cmd: string, payload: any, o?: unknown) => {
    calls.push(cmd);
    if (cmd === 'service.deploy' && payload.spec.name === failDeployOf) {
      failDeployOf = null;
      throw new Error('controller restarted');
    }
    return inner(n, cmd as never, payload, o as never);
  };
  (w.ctx.db as any).auditLog.create = async ({ data }: any) => void audit.push(data);
  // The promotion pass: R takes the writes, the old writer P is down.
  const failover = () => {
    w.services.get(R)!.labels['swarmy.db.role'] = 'primary';
    Object.assign(w.services.get(P)!, { runningReplicas: 0 });
    w.services.get(P)!.labels['swarmy.db.role'] = 'replica';
  };
  return { w, calls, audit, failover, failNextDeployOf: (name: string) => void (failDeployOf = name) };
}

const ref = (w: ReturnType<typeof world>, app: string, target: string) => w.services.get(app)!.refs.find((r) => r.target === target)?.source;

describe('repointDbApps — a failover', () => {
  it('a direct app gets a URL for the new writer as a new secret; the old version goes', async () => {
    const { w, audit, failover } = await wired([{ name: 'shop_api' }]);
    expect(ref(w, 'shop_api', 'DATABASE_URL')).toBe('shop_main-pg-url__v1');
    failover();
    const res = await repointDbApps(w.ctx, { stack: STACK, cluster: CLUSTER });
    expect(res.moved).toEqual([{ service: 'shop_api', from: P, ro: R }]);
    expect(ref(w, 'shop_api', 'DATABASE_URL')).toBe('shop_main-pg-url__v2');
    expect(w.secrets.get('shop_main-pg-url__v2')).toBe(`postgres://postgres:${PW}@${R}:5432/app`);
    expect(w.secretLabels.get('shop_main-pg-url__v2')?.['swarmy.db.secret.host']).toBe(R);
    expect(w.services.get('shop_api')!.labels['swarmy.db.inject.host']).toBe(R);
    // Its read-only URL named the promoted copy and no other standby runs: the writer, the same content, reused.
    expect(ref(w, 'shop_api', 'DATABASE_RO_URL')).toBe('shop_main-pg-ro-url__v1');
    expect(w.secrets.has('shop_main-pg-url__v1')).toBe(false);
    expect(res.retired).toEqual(['shop_main-pg-url__v1']);
    expect(audit.filter((a) => a.action === 'db.repoint.app').map((a) => a.metadata)).toEqual([{ app: 'shop_api', from: P, to: R, roFrom: R, ro: R }]);
    w.assertNowhere(PW);
  });

  it('a pooler app is untouched; a second call dispatches nothing', async () => {
    const { w, calls, failover } = await wired([{ name: 'shop_api' }, { name: 'shop_web', via: 'pooler' }]);
    const webRefs = JSON.stringify(w.services.get('shop_web')!.refs);
    const webGen = w.services.get('shop_web')!.gen;
    failover();
    await repointDbApps(w.ctx, { stack: STACK, cluster: CLUSTER });
    expect(w.services.get('shop_web')!.gen).toBe(webGen);
    expect(JSON.stringify(w.services.get('shop_web')!.refs)).toBe(webRefs);
    calls.length = 0;
    expect(await repointDbApps(w.ctx, { stack: STACK, cluster: CLUSTER })).toMatchObject({ moved: [], failed: [] });
    expect(calls).toEqual([]);
  });

  it('rolls start-first where the app allows; an app writing to a volume keeps its order', async () => {
    const { w, failover } = await wired([{ name: 'shop_api' }, { name: 'shop_files', mounts: true }]);
    failover();
    await repointDbApps(w.ctx, { stack: STACK, cluster: CLUSTER });
    const last = (name: string) => w.specsSeen.filter((s: any) => s.name === name).at(-1) as { updateConfig?: { order?: string } };
    expect(last('shop_api').updateConfig?.order).toBe('start-first');
    expect(last('shop_files').updateConfig).toBeUndefined();
  });

  it('the promotion pass names the writer before the inventory says so', async () => {
    const { w } = await wired([{ name: 'shop_api' }]);
    const res = await repointDbApps(w.ctx, { stack: STACK, cluster: CLUSTER, writer: R, standbys: [{ service: P, running: 0 }] });
    expect(res.moved.map((m) => m.service)).toEqual(['shop_api']);
    expect(w.secrets.get(ref(w, 'shop_api', 'DATABASE_URL')!)).toContain(`@${R}:5432/`);
  });
});

describe('repointDbApps — resumable', () => {
  it('a pass cut short: the next one moves the rest onto the same secret, then the old one goes', async () => {
    const { w, failover, failNextDeployOf } = await wired([{ name: 'shop_api' }, { name: 'shop_worker' }]);
    failover();
    failNextDeployOf('shop_worker');
    const first = await repointDbApps(w.ctx, { stack: STACK, cluster: CLUSTER });
    expect(first.moved.map((m) => m.service)).toEqual(['shop_api']);
    expect(first.failed).toEqual([{ service: 'shop_worker', error: expect.stringContaining('controller restarted') }]);
    expect(w.secrets.has('shop_main-pg-url__v1')).toBe(true); // shop_worker still mounts it
    const second = await repointDbApps(w.ctx, { stack: STACK, cluster: CLUSTER });
    expect(second.moved.map((m) => m.service)).toEqual(['shop_worker']);
    expect(ref(w, 'shop_worker', 'DATABASE_URL')).toBe('shop_main-pg-url__v2');
    expect(ref(w, 'shop_api', 'DATABASE_URL')).toBe('shop_main-pg-url__v2');
    expect(w.secrets.has('shop_main-pg-url__v1')).toBe(false);
  });

  it('a Connect after the failover names the new writer, sharing the repointed secret', async () => {
    const { w, failover } = await wired([{ name: 'shop_api' }]);
    failover();
    await repointDbApps(w.ctx, { stack: STACK, cluster: CLUSTER });
    w.put({ name: 'shop_admin', image: 'web:1', labels: { 'com.docker.stack.namespace': STACK }, networks: ['shop_default'] });
    await injectConnection(w.ctx, { stack: STACK, cluster: CLUSTER, appService: 'shop_admin' });
    expect(ref(w, 'shop_admin', 'DATABASE_URL')).toBe('shop_main-pg-url__v2');
    expect(w.services.get('shop_admin')!.labels['swarmy.db.inject.host']).toBe(R);
  });
});
