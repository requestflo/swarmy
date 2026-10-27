import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { encodeSwitchoverRequest } from '@swarmy/core';
import { createTestDb, type TestDb } from '@swarmy/db';
import { hub } from '../gateway';
import { probeCopies } from './manageddb-copies';
import { copiesSwarm } from './manageddb-copies.fake';
import { indexClusters, maybePromote, type ClusterLag, type Contract } from './manageddb-reconcile';
import { PROMOTION_GRACE_TICKS } from './manageddb-reconcile.core';

/**
 * What a promotion leaves behind, end to end through the reconcile's
 * promotion pass on a fake swarm: the promoted writer is pinned to the server
 * its data is on (a 1-copy standby, a planned switchover — the retire flow
 * rides the same request), and a geo cluster's region declarations and labels
 * follow the writer, as provisioning writes them.
 */

const ORGS = ['org-carry-geo', 'org-carry-one', 'org-carry-planned'];
const P = 'shop_main-primary';
const R = 'shop_main-replica';
const EU = 'shop_main-replica-eu';
const AP = 'shop_main-replica-ap';
const MARK = '0/3000000';
const REGIONS = { 'swarm-a': { 'swarmy.region': 'us' }, 'swarm-b': { 'swarmy.region': 'eu' }, 'swarm-c': { 'swarmy.region': 'ap' } };
let t: TestDb;
let swarm: ReturnType<typeof copiesSwarm> | null = null;
beforeAll(async () => {
  t = await createTestDb();
  for (const id of ORGS) await t.db.organization.create({ data: { id, name: id, slug: id, createdAt: new Date() } });
});
afterAll(async () => t?.close());
afterEach(() => {
  swarm?.uninstall();
  swarm = null;
});

const pg = (topology: string) => ({ 'com.docker.stack.namespace': 'shop', 'swarmy.managed': 'true', 'swarmy.db.engine': 'postgres', 'swarmy.db.cluster': 'main', 'swarmy.db.topology': topology });
const member = { image: 'pgvector/pgvector:pg17', networks: ['shop_main-net'] };
const standbyEnv = { SWARMY_PG_ROLE: 'replica', SWARMY_PG_PRIMARY_HOST: P };

function seed(org: string, topology: string, writer: Record<string, string> = {}): ReturnType<typeof copiesSwarm> {
  const s = (swarm = copiesSwarm(org, REGIONS));
  const cons = writer['swarmy.db.placedRegion'] ? [`node.labels.swarmy.region==${writer['swarmy.db.placedRegion']}`, 'node.id==swarm-a'] : ['node.id==swarm-a'];
  s.put({ ...member, name: P, labels: { ...pg(topology), 'swarmy.db.role': 'primary', 'swarmy.db.dataVolume': 'shop_main-primary-data', 'swarmy.db.node': 'swarm-a', 'swarmy.db.memoryMb': '1024', ...writer }, env: { SWARMY_PG_ROLE: 'primary' }, placement: { constraints: cons } });
  return s;
}
function sibling(s: ReturnType<typeof copiesSwarm>, region: string): void {
  const labels = { ...pg('geo'), 'swarmy.db.role': 'replica', 'swarmy.db.region': region, 'swarmy.db.replicas': '1', 'swarmy.db.dataVolume': `shop_main-replica-${region}-data`, 'swarmy.db.avoidNode': 'swarm-a' };
  s.put({ ...member, name: `shop_main-replica-${region}`, labels, env: standbyEnv, placement: { constraints: [`node.labels.swarmy.region==${region}`, 'node.id!=swarm-a'] } });
}
function standby(s: ReturnType<typeof copiesSwarm>, topology: string): void {
  const labels = { ...pg(topology), 'swarmy.db.role': 'replica', 'swarmy.db.replicas': '1', 'swarmy.db.dataVolume': 'shop_main-replica-data', 'swarmy.db.avoidNode': 'swarm-a' };
  s.put({ ...member, name: R, labels, env: standbyEnv, placement: { constraints: ['node.id!=swarm-a'] } });
}

const cluster = (org: string) => indexClusters(hub.liveInventory(org).services).get('shop main')!;
async function contract(org: string): Promise<Contract> {
  const seams = await import('@swarmy/trpc');
  return { seams, ctx: seams.systemContext({ db: t.db, hub, auth: {} as never }, org) };
}
async function lag(org: string, primaryLsn: string | null): Promise<ClusterLag> {
  const c = cluster(org);
  return { members: {}, primaryLsn, copies: await probeCopies(org, [c.replica, ...c.regionReplicas.values()].filter((x) => !!x)) };
}
/** A healthy tick samples the watermark; then the writer stops (died, or paused by a planned run). */
async function outage(org: string, topology: 'geo' | 'failover', planned?: string): Promise<void> {
  const k = await contract(org);
  await maybePromote(k, org, 'n1', cluster(org), topology, await lag(org, MARK));
  const p = swarm!.services.get(P)!;
  p.down = true;
  if (planned) p.spec.labels!['swarmy.db.switchover'] = encodeSwitchoverRequest({ at: new Date().toISOString(), target: planned, copy: 'swarm-b', finalLsn: MARK });
  for (let i = 0; i <= (planned ? 0 : PROMOTION_GRACE_TICKS); i++) await maybePromote(k, org, 'n1', cluster(org), topology, await lag(org, null));
}

describe('the promoted writer is pinned to the server its data is on', () => {
  it('a 1-copy standby promoted by a failover: one copy, pinned, stop-first, its env unchanged', async () => {
    const s = seed(ORGS[1]!, 'failover');
    standby(s, 'failover');
    s.install();
    await outage(ORGS[1]!, 'failover');
    expect([...s.writers]).toEqual([`${R}@swarm-b`]);
    const w = s.services.get(R)!.spec;
    expect(w.labels).toMatchObject({ 'swarmy.db.role': 'primary', 'swarmy.db.node': 'swarm-b', 'swarmy.db.memoryMb': '1024' });
    expect(w.labels?.['swarmy.db.avoidNode']).toBeUndefined();
    expect(w.labels?.['swarmy.db.failover.promoting']).toBeUndefined();
    expect(w.placement?.constraints).toEqual(['node.id==swarm-b']);
    expect(w.mode?.replicated?.replicas).toBe(1);
    expect(w.updateConfig?.order).toBe('stop-first');
    expect(w.env).toMatchObject(standbyEnv);
    expect(s.nodesOf(R)).toEqual(['swarm-b']);
  });

  it('a planned switchover (and the retire flow, which rides it) pins the writer the same way', async () => {
    const s = seed(ORGS[2]!, 'primary-replica');
    standby(s, 'primary-replica');
    s.install();
    await outage(ORGS[2]!, 'failover', R);
    const w = s.services.get(R)!.spec;
    expect(w.labels?.['swarmy.db.role']).toBe('primary');
    expect(w.labels?.['swarmy.db.node']).toBe('swarm-b');
    expect(w.placement?.constraints).toEqual(['node.id==swarm-b']);
  });
});

describe('a geo failover keeps the regional layout', () => {
  it('the writer takes the declarations and its region; standbys keep theirs', async () => {
    const s = seed(ORGS[0]!, 'geo', { 'swarmy.db.writeRegion': 'us', 'swarmy.db.placedRegion': 'us', 'swarmy.db.region.eu.replicas': '1', 'swarmy.db.region.ap.replicas': '1' });
    sibling(s, 'eu');
    sibling(s, 'ap');
    s.replay.set(`${AP}@swarm-c`, '0/2FFFFFF'); // one byte behind: eu is the one
    s.install();
    await outage(ORGS[0]!, 'geo');
    expect([...s.writers]).toEqual([`${EU}@swarm-b`]);

    const w = s.services.get(EU)!.spec;
    expect(w.labels).toMatchObject({
      'swarmy.db.role': 'primary',
      'swarmy.db.topology': 'geo',
      'swarmy.db.region.eu.replicas': '1',
      'swarmy.db.region.ap.replicas': '1',
      'swarmy.db.writeRegion': 'eu',
      'swarmy.db.placedRegion': 'eu',
      'swarmy.db.region': 'eu',
      'swarmy.db.node': 'swarm-b',
    });
    expect(w.placement?.constraints).toEqual(['node.labels.swarmy.region==eu', 'node.id==swarm-b']);

    const ap = s.services.get(AP)!.spec;
    expect(ap.labels).toMatchObject({ 'swarmy.db.role': 'replica', 'swarmy.db.region': 'ap', 'swarmy.db.writeRegion': 'eu', 'swarmy.db.leader': EU });
    expect(ap.placement?.constraints).toContain('node.labels.swarmy.region==ap');

    const ex = s.services.get(P)!.spec;
    expect(ex.labels).toMatchObject({ 'swarmy.db.role': 'replica', 'swarmy.db.writeRegion': 'eu', 'swarmy.db.node': 'swarm-a' });
    for (const k of ['swarmy.db.region.eu.replicas', 'swarmy.db.region.ap.replicas', 'swarmy.db.placedRegion']) expect(ex.labels?.[k]).toBeUndefined();
    expect(ex.placement?.constraints).toEqual(['node.labels.swarmy.region==us', 'node.id==swarm-a']);
    const audit = await t.db.auditLog.findFirst({ where: { orgId: ORGS[0]!, action: 'db.failover.promote' } });
    expect(audit?.metadata).toMatchObject({ promoted: EU, copy: 'swarm-b', writeRegion: { from: 'us', to: 'eu' } });
  });
});
