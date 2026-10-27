import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { createTestDb, type TestDb } from '@swarmy/db';
import { hub } from '../gateway';
import { probeCopies } from './manageddb-copies';
import { copiesSwarm } from './manageddb-copies.fake';
import { indexClusters, maybePromote, type ClusterLag, type Contract } from './manageddb-reconcile';
import { PROMOTION_GRACE_TICKS } from './manageddb-reconcile.core';
import { convergeReshape } from './manageddb-reshape';

/**
 * One promotion, one writer — end to end through the reconcile's promotion
 * pass on a swarm whose standby service runs TWO copies (one per server, the
 * default shape for `replicas: 2`). The pass probes each copy, promotes only
 * the caught-up one in its own container, and the service comes back as that
 * one copy pinned to its server; a retried pass resumes that copy and never
 * another; copies that already write are refused loudly, never promoted.
 */

const ORG = 'org-copies';
const P = 'shop_main-primary';
const R = 'shop_main-replica';
const MARK = '0/3000000';
let t: TestDb;
let swarm: ReturnType<typeof copiesSwarm> | null = null;
beforeAll(async () => {
  t = await createTestDb();
  await t.db.organization.create({ data: { id: ORG, name: 'copies', slug: 'copies', createdAt: new Date() } });
});
afterAll(async () => t?.close());
afterEach(() => {
  swarm?.uninstall();
  swarm = null;
});

function seed(): ReturnType<typeof copiesSwarm> {
  const s = copiesSwarm(ORG);
  const pg = { 'com.docker.stack.namespace': 'shop', 'swarmy.managed': 'true', 'swarmy.db.engine': 'postgres', 'swarmy.db.cluster': 'main', 'swarmy.db.topology': 'failover', 'swarmy.db.replicas': '2' };
  const member = { image: 'pgvector/pgvector:pg17', networks: ['shop_main-net'] };
  s.put({ ...member, name: P, labels: { ...pg, 'swarmy.db.role': 'primary', 'swarmy.db.dataVolume': 'shop_main-primary-data', 'swarmy.db.node': 'swarm-a' }, env: { SWARMY_PG_ROLE: 'primary' }, placement: { constraints: ['node.id==swarm-a'] } });
  s.put({ ...member, name: R, mode: { replicated: { replicas: 2 } }, labels: { ...pg, 'swarmy.db.role': 'replica', 'swarmy.db.dataVolume': 'shop_main-replica-data', 'swarmy.db.avoidNode': 'swarm-a' }, env: { SWARMY_PG_ROLE: 'replica', SWARMY_PG_PRIMARY_HOST: P }, placement: { constraints: ['node.id!=swarm-a'] } });
  s.install();
  return s;
}

const cluster = () => indexClusters(hub.liveInventory(ORG).services).get('shop main')!;
async function contract(): Promise<Contract> {
  const seams = await import('@swarmy/trpc');
  return { seams, ctx: seams.systemContext({ db: t.db, hub, auth: {} as never }, ORG) };
}
async function lag(primaryLsn: string | null): Promise<ClusterLag> {
  const c = cluster();
  return { members: {}, primaryLsn, copies: await probeCopies(ORG, c.replica ? [c.replica] : []) };
}
/** A healthy tick samples the watermark; then the writer dies and the grace window runs out. */
async function outage(s: ReturnType<typeof copiesSwarm>, k: Contract): Promise<void> {
  await maybePromote(k, ORG, 'n1', cluster(), 'failover', await lag(MARK));
  s.services.get(P)!.down = true;
  for (let i = 0; i <= PROMOTION_GRACE_TICKS; i++) await maybePromote(k, ORG, 'n1', cluster(), 'failover', await lag(null));
}
const promoteExecs = (s: ReturnType<typeof copiesSwarm>) => s.execs.filter((e) => e.script.includes('pg_promote')).map((e) => e.copy);
const reshapeTick = () =>
  convergeReshape(cluster().primary, 'shop_main-net', {
    runningCopies: () => swarm!.nodesOf(cluster().primary!.name).length,
    scale: (service, replicas) => hub.dispatch('n1', 'service.scale', { service, replicas }),
    deploy: (spec) => hub.dispatch('n1', 'service.deploy', { spec, pullPolicy: 'missing' }),
    removeMark: () => Promise.resolve(),
  });

describe('failover promotes ONE copy of a two-copy standby service', () => {
  it('only the caught-up copy runs pg_promote; the service comes back as that one copy, pinned', async () => {
    const s = (swarm = seed());
    s.replay.set(`${R}@swarm-b`, '0/2FFFFFF'); // one byte behind
    expect(s.nodesOf(R)).toEqual(['swarm-b', 'swarm-c']);
    await outage(s, await contract());

    expect(promoteExecs(s)).toEqual([`${R}@swarm-c`]);
    expect([...s.writers]).toEqual([`${R}@swarm-c`]);
    const promoted = s.info(R);
    expect(promoted.labels['swarmy.db.role']).toBe('primary');
    expect(promoted.labels['swarmy.db.failover.promoting']).toBe('swarm-c');
    expect(promoted.desiredReplicas).toBe(0); // every copy stops before it comes back as one
    // The demoted writer takes the standby copies: floating, off the new writer's server.
    const ex = s.services.get(P)!.spec;
    expect(ex.labels?.['swarmy.db.role']).toBe('replica');
    expect(ex.labels?.['swarmy.db.node']).toBeUndefined();
    expect(ex.labels?.['swarmy.db.avoidNode']).toBe('swarm-c');
    expect(ex.mode?.replicated?.replicas).toBe(2);
    expect(ex.env?.SWARMY_PG_PRIMARY_HOST).toBe(R);

    // Down on purpose: no second promotion while it is reshaped.
    await maybePromote(await contract(), ORG, 'n1', cluster(), 'failover', await lag(null));
    expect(promoteExecs(s)).toEqual([`${R}@swarm-c`]);
    expect(await reshapeTick()).toBe('pin');
    const spec = s.services.get(R)!.spec;
    expect(spec.mode?.replicated?.replicas).toBe(1);
    expect(spec.placement?.constraints).toContain('node.id==swarm-c');
    expect(spec.updateConfig?.order).toBe('stop-first');
    expect(spec.labels?.['swarmy.db.failover.promoting']).toBeUndefined();
    expect(s.nodesOf(R)).toEqual(['swarm-c']);
    expect(await reshapeTick()).toBe('none');
  });

  it('a pass whose promote reply was lost resumes THAT copy, even when another now looks better', async () => {
    const s = (swarm = seed());
    s.replay.set(`${R}@swarm-b`, '0/2FFFFFF');
    s.loseReply.add(`${R}@swarm-c`);
    await outage(s, await contract());
    // The exec landed on swarm-c, its reply was lost: still a "standby" by labels, marked.
    expect(promoteExecs(s)).toEqual([`${R}@swarm-c`]);
    expect(s.info(R).labels['swarmy.db.role']).toBe('replica');
    expect(s.info(R).labels['swarmy.db.failover.promoting']).toBe('swarm-c');
    // Next pass: swarm-b now reports more replayed; the marked copy is resumed, not re-chosen.
    s.replay.set(`${R}@swarm-b`, '0/3000100');
    await maybePromote(await contract(), ORG, 'n1', cluster(), 'failover', await lag(null));
    expect(promoteExecs(s)).toEqual([`${R}@swarm-c`]);
    expect([...s.writers]).toEqual([`${R}@swarm-c`]);
    expect(s.info(R).labels['swarmy.db.role']).toBe('primary');
    const audit = await t.db.auditLog.findFirst({ where: { orgId: ORG, action: 'db.failover.promote' }, orderBy: { ts: 'desc' } });
    expect(audit?.metadata).toMatchObject({ promoted: R, copy: 'swarm-c', resumed: true, reshaped: true });
  });

  it('two copies already writing: refused loudly, nothing promoted', async () => {
    const s = (swarm = seed());
    s.writers.add(`${R}@swarm-b`).add(`${R}@swarm-c`);
    await outage(s, await contract());
    expect(promoteExecs(s)).toEqual([]);
    expect(s.info(R).labels['swarmy.db.role']).toBe('replica');
    const incident = await t.db.incidentEvent.findFirst({ where: { orgId: ORG, kind: 'db.failover.refused' } });
    expect(incident?.message).toContain('2 standby copies already take writes');
    const audit = await t.db.auditLog.findFirst({ where: { orgId: ORG, action: 'db.failover.refused' } });
    expect(audit).not.toBeNull();
  });

  it('beside a healthy writer: a stale mark is dropped; a standby copy that writes for two ticks is raised', async () => {
    const s = (swarm = seed());
    s.services.get(R)!.spec.labels!['swarmy.db.failover.promoting'] = 'swarm-b';
    await maybePromote(await contract(), ORG, 'n1', cluster(), 'failover', await lag(MARK));
    expect(s.info(R).labels['swarmy.db.failover.promoting']).toBeUndefined();
    s.writers.add(`${R}@swarm-b`);
    for (let i = 0; i < 2; i++) await maybePromote(await contract(), ORG, 'n1', cluster(), 'failover', await lag(MARK));
    const raised = await t.db.incidentEvent.findMany({ where: { orgId: ORG, kind: 'db.failover.refused' } });
    expect(raised.some((e) => e.message.includes(`${R} on swarm-b takes writes while ${P} is the writer`))).toBe(true);
    expect(promoteExecs(s)).toEqual([]);
  });
});
