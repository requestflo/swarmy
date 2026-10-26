import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createTestDb, type TestDb } from '@swarmy/db';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { checkRollback, lastRollback, markRollback } from './rollback-watch';

/**
 * Rollback timing against a real store: the start goes on the rollback's
 * release before anything settles, the watcher stamps healthyAt once the live
 * swarm runs the put-back version with every copy, and lastRollback reads it.
 */
let t: TestDb;
let seq = 0;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
});

const live = (image: string, running = 2): SwarmServiceInfo =>
  ({ id: 'svc', name: 'shop_web', image, mode: 'replicated', desiredReplicas: 2, runningReplicas: running, updateStatus: 'completed', labels: {}, networks: [], env: [], ports: [], createdAt: 0, updatedAt: 0 }) as unknown as SwarmServiceInfo;

async function setup(): Promise<{ ctx: OrgContext; swarm: { services: SwarmServiceInfo[] }; releaseId: string; orgId: string }> {
  const orgId = `org_${++seq}`;
  await t.db.organization.create({ data: { id: orgId, name: orgId, slug: orgId, createdAt: new Date() } });
  const rel = await t.db.release.create({
    data: { orgId, stackName: 'shop', composeSource: 'x', imagesJson: [{ name: 'shop_web', image: 'ghcr.io/nw/web:1.8.2' }], status: 'DEPLOYING' },
  });
  const swarm = { services: [live('ghcr.io/nw/web:1.9.0@sha256:new')] };
  const ctx = { db: t.db, hub: { liveInventory: () => ({ services: swarm.services, containers: [] }) }, activeOrgId: orgId, user: null } as unknown as OrgContext;
  return { ctx, swarm, releaseId: rel.id, orgId };
}

describe('markRollback + the watcher', () => {
  it('records the start, then healthyAt once the put-back version runs every copy', async () => {
    const { ctx, swarm, releaseId, orgId } = await setup();
    const startedAt = new Date(Date.now() - 41_000);
    await markRollback(ctx, { releaseId, rollbackOf: 'rel-old', startedAt, notes: 'Rollback to release rel-old' }, { everyMs: 5 });
    const row = await t.db.release.findUniqueOrThrow({ where: { id: releaseId } });
    expect(row).toMatchObject({ rollbackOf: 'rel-old', startedAt, healthyAt: null, notes: 'Rollback to release rel-old' });
    expect(await lastRollback(ctx, {})).toBeNull();

    swarm.services = [live('ghcr.io/nw/web:1.8.2@sha256:old', 1)];
    await Bun.sleep(30);
    expect((await t.db.release.findUniqueOrThrow({ where: { id: releaseId } })).healthyAt).toBeNull();

    swarm.services = [live('ghcr.io/nw/web:1.8.2@sha256:old', 2)];
    for (let i = 0; i < 40 && !(await lastRollback(ctx, {})); i++) await Bun.sleep(10);
    const last = await lastRollback(ctx, { stackName: 'shop' });
    expect(last).toMatchObject({ releaseId, stackName: 'shop', rollbackOf: 'rel-old' });
    expect(last!.tookSec).toBeGreaterThanOrEqual(41);
    expect(last!.tookSec).toBeLessThan(45);
    expect(await lastRollback(ctx, { stackName: 'other' })).toBeNull();
    const audit = await t.db.auditLog.findMany({ where: { orgId } });
    expect(audit.map((a) => a.action)).toEqual(['release.rollback.healthy']);
  });

  it('stamps healthyAt once, and not while Docker paused the update', async () => {
    const { ctx, swarm, releaseId } = await setup();
    const w = { id: releaseId, stackName: 'shop', rollbackOf: 'rel-old', startedAt: new Date(), images: [{ name: 'shop_web', image: 'ghcr.io/nw/web:1.8.2' }] };
    swarm.services = [{ ...live('ghcr.io/nw/web:1.8.2'), updateStatus: 'paused' }];
    expect(await checkRollback(ctx, w)).toBe('failed');
    swarm.services = [live('ghcr.io/nw/web:1.8.2')];
    const first = new Date();
    expect(await checkRollback(ctx, w, first)).toBe('healthy');
    expect(await checkRollback(ctx, w, new Date(first.getTime() + 60_000))).toBe('healthy');
    expect((await t.db.release.findUniqueOrThrow({ where: { id: releaseId } })).healthyAt).toEqual(first);
  });

  it('a normal deploy is never a rollback', async () => {
    const { ctx, releaseId } = await setup();
    await t.db.release.update({ where: { id: releaseId }, data: { healthyAt: new Date(), startedAt: new Date() } });
    expect(await lastRollback(ctx, {})).toBeNull();
  });
});
