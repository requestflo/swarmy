import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { createTestDb, type TestDb } from '@swarmy/db';
import { hub } from '../gateway';
import { followWriter, resetAppsFollow, type AppsCluster } from './manageddb-apps';
import { fakeSwarm } from './manageddb-apps.fake';
import { indexClusters, maybePromote, type ClusterLag, type Contract } from './manageddb-reconcile';
import { PROMOTION_GRACE_TICKS } from './manageddb-reconcile.core';

/**
 * End to end through the manageddb reconcile's promotion pass, on a fake
 * swarm installed on the controller's hub and a real controller store: the
 * writer dies, a caught-up standby is promoted, and an app wired straight to
 * the cluster is rolled onto a URL secret naming the new writer, on the
 * incident timeline. An app through the pooler is never touched; the next
 * tick sends nothing; a pass the controller didn't finish is finished by the
 * next tick.
 */

const ORG = 'org-follow';
const P = 'shop_main-primary';
const R = 'shop_main-replica';
const PW = 'e2e-follow-the-writer';
const SECRET = 'shop_main-pg-password__v1';
const url = (host: string, port = 5432) => `postgres://postgres:${PW}@${host}:${port}/shop`;

let t: TestDb;
let swarm: ReturnType<typeof fakeSwarm> | null = null;
beforeAll(async () => {
  t = await createTestDb();
  await t.db.organization.create({ data: { id: ORG, name: 'follow', slug: 'follow', createdAt: new Date() } });
});
afterAll(async () => {
  await t?.close();
});
afterEach(() => {
  swarm?.uninstall();
  swarm = null;
  resetAppsFollow();
});

function seed(): ReturnType<typeof fakeSwarm> {
  const s = fakeSwarm(ORG);
  const pg = { 'com.docker.stack.namespace': 'shop', 'swarmy.managed': 'true', 'swarmy.db.engine': 'postgres', 'swarmy.db.cluster': 'main', 'swarmy.db.topology': 'primary-replica', 'swarmy.db.passwordSecret': SECRET };
  const file = { POSTGRES_PASSWORD_FILE: '/run/secrets/shop_main-pg-password', SWARMY_PG_REPLICATION_USER: 'repl' };
  const member = { image: 'pgvector/pgvector:pg17', networks: ['shop_main-net'], secrets: [{ source: SECRET, target: 'shop_main-pg-password' }] };
  s.put({ ...member, name: P, labels: { ...pg, 'swarmy.db.role': 'primary' }, env: { ...file, SWARMY_PG_ROLE: 'primary', POSTGRES_DB: 'shop' } });
  s.put({ ...member, name: R, labels: { ...pg, 'swarmy.db.role': 'replica' }, env: { ...file, SWARMY_PG_ROLE: 'replica', SWARMY_PG_PRIMARY_HOST: P } });
  const app = (name: string, rw: string, labels: Record<string, string>) =>
    s.put({
      name,
      image: 'shop:1',
      labels: { 'com.docker.stack.namespace': 'shop', 'swarmy.db.inject': 'main', 'swarmy.db.inject.var': 'DATABASE_URL', 'swarmy.db.inject.roHost': R, ...labels },
      networks: ['shop_default', 'shop_main-net'],
      secrets: [{ source: rw, target: 'DATABASE_URL' }, { source: 'shop_main-pg-ro-url__v1', target: 'DATABASE_RO_URL' }],
      secretEnv: ['DATABASE_RO_URL', 'DATABASE_URL'],
    });
  app('shop_api', 'shop_main-pg-url__v1', { 'swarmy.db.inject.host': P });
  app('shop_web', 'shop_main-pg-pool-url__v1', { 'swarmy.db.inject.via': 'pooler' });
  s.seedSecret(SECRET, PW);
  s.seedSecret('shop_main-pg-url__v1', url(P));
  s.seedSecret('shop_main-pg-ro-url__v1', url(R));
  s.seedSecret('shop_main-pg-pool-url__v1', url('shop_main-pooler', 6432));
  s.install();
  return s;
}

const cluster = () => indexClusters(hub.liveInventory(ORG).services).get('shop main')!;
const apps = (): AppsCluster => {
  const c = cluster();
  return { stack: 'shop', cluster: 'main', ...(c.primary ? { primary: c.primary } : {}), standbys: c.replica ? [c.replica] : [] };
};
const lag = (primaryLsn: string | null): ClusterLag => ({ members: { [R]: { lagSeconds: 0, lsnDiffBytes: 0, replayLsn: '0/3000000' } }, primaryLsn });
const rwOf = (s: ReturnType<typeof fakeSwarm>, app: string) => s.services.get(app)!.refs.find((r) => r.target === 'DATABASE_URL')!.source;

async function failover(s: ReturnType<typeof fakeSwarm>): Promise<Contract> {
  const seams = await import('@swarmy/trpc');
  const contract: Contract = { seams, ctx: seams.systemContext({ db: t.db, hub, auth: {} as never }, ORG) };
  // A healthy tick samples the writer's flushed position (the watermark)…
  await maybePromote(contract, ORG, 'n1', cluster(), 'primary-replica', lag('0/3000000'));
  // …then the writer dies; the standby has replayed all of it.
  s.services.get(P)!.down = true;
  for (let i = 0; i <= PROMOTION_GRACE_TICKS; i++) await maybePromote(contract, ORG, 'n1', cluster(), 'primary-replica', lag(null));
  expect(s.info(R).labels['swarmy.db.role']).toBe('primary');
  return contract;
}

const follow = (contract: Contract) => ({
  repoint: (o: object) => contract.seams.repointDbApps(contract.ctx, { stack: 'shop', cluster: 'main', ...o }),
});

describe('failover → apps wired straight to the cluster follow the writer', () => {
  it('the app spec carries a new URL secret naming the promoted writer; the pooler app is untouched', async () => {
    const s = (swarm = seed());
    const contract = await failover(s);
    expect(rwOf(s, 'shop_api')).toBe('shop_main-pg-url__v2');
    expect(s.secrets.get('shop_main-pg-url__v2')!.value).toBe(url(R));
    expect(s.info('shop_api').labels['swarmy.db.inject.host']).toBe(R);
    expect(s.secrets.has('shop_main-pg-url__v1')).toBe(false);
    expect(s.services.get('shop_web')!.gen).toBe(1);
    const events = await t.db.incidentEvent.findMany({ where: { orgId: ORG }, orderBy: { at: 'asc' } });
    expect(events.map((e) => e.message)).toContain(`Repointed shop_api at ${R}`);
    const promote = await t.db.auditLog.findFirst({ where: { orgId: ORG, action: 'db.failover.promote' }, orderBy: { ts: 'desc' } });
    expect((promote!.metadata as { apps: string[] }).apps).toEqual(['shop_api']);

    // The next tick, with the inventory caught up: nothing to send.
    s.calls.length = 0;
    expect(await followWriter(`${ORG}/shop/main`, apps(), hub.liveInventory(ORG).services, follow(contract))).toBe(false);
    expect(s.calls).toEqual([]);
  });

  it('a pass the controller did not finish: the next tick moves the app', async () => {
    const s = (swarm = seed());
    s.failNextDeploy.add('shop_api');
    const contract = await failover(s);
    expect(rwOf(s, 'shop_api')).toBe('shop_main-pg-url__v1');
    expect(await followWriter(`${ORG}/shop/main`, apps(), hub.liveInventory(ORG).services, follow(contract))).toBe(true);
    expect(rwOf(s, 'shop_api')).toBe('shop_main-pg-url__v2');
    expect(s.secrets.get('shop_main-pg-url__v2')!.value).toBe(url(R));
    expect(s.secrets.has('shop_main-pg-url__v1')).toBe(false);
  });
});
