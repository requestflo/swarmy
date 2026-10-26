import { afterEach, describe, expect, it } from 'bun:test';
import { DB_SWITCHOVER_LABEL, encodeSwitchoverRequest } from '@swarmy/core';
import { fakeSwitchover } from './manageddb-switchover.fake';
import { resetSwitchoverRuns } from './manageddb-switchover.runs';
import { planDbSwitchover } from './manageddb-switchover.service';
import { getDbSwitchoverRun, startDbSwitchover } from './manageddb-switchover.start';

/**
 * `db.switchover`'s live facts → the shared plan: the members off the live
 * inventory, each standby's row from the studio's `pg_stat_replication`
 * read, the apps wired straight to the writer (named to restart), and
 * anything in flight.
 */

afterEach(() => resetSwitchoverRuns());

describe('planDbSwitchover — gathered from Docker truth and the writer', () => {
  it('names the standby on wkr-2 and reads its lag from pg_stat_replication', async () => {
    const f = fakeSwitchover();
    const { plan } = await planDbSwitchover(f.ctx, { stack: 'shop', cluster: 'db' });
    expect(plan).toEqual({ ok: true, from: 'shop_db-primary', target: 'shop_db-replica', nodeId: 'n2', behindBytes: 120, restarts: [] });
    expect(f.calls.filter((c) => c.cmd === 'db.query')).toHaveLength(1);
    expect(f.audit).toEqual(['studio.query']);
  });

  it('an app wired straight to the writer restarts onto the new one; one through the pooler is untouched', async () => {
    const direct = await planDbSwitchover(fakeSwitchover({ app: 'direct' }).ctx, { stack: 'shop', cluster: 'db' });
    expect(direct.plan).toMatchObject({ ok: true, restarts: ['shop_api'] });
    const pooled = await planDbSwitchover(fakeSwitchover({ app: 'pooler', pooler: true }).ctx, { stack: 'shop', cluster: 'db' });
    expect(pooled.plan).toMatchObject({ ok: true, restarts: [] });
  });

  it('still refused: a standby service holding two copies (promotion is per service)', async () => {
    const { plan } = await planDbSwitchover(fakeSwitchover({ shared: true, app: 'direct' }).ctx, { stack: 'shop', cluster: 'db', target: 'shop_db-replica' });
    expect(plan).toMatchObject({ ok: false, code: 'shared-copy' });
  });

  it('a fresh request on the writer means a switchover is already running', async () => {
    const f = fakeSwitchover();
    f.primary.labels[DB_SWITCHOVER_LABEL] = encodeSwitchoverRequest({ at: new Date().toISOString(), target: 'shop_db-replica' });
    const { plan } = await planDbSwitchover(f.ctx, { stack: 'shop', cluster: 'db' });
    expect(plan).toMatchObject({ ok: false, code: 'busy', reason: 'A switch-over is already running.' });
  });

  it('a held failover comes first', async () => {
    const f = fakeSwitchover();
    f.replica.labels['swarmy.db.failover.pending'] = '{"target":"shop_db-replica"}';
    const { plan } = await planDbSwitchover(f.ctx, { stack: 'shop', cluster: 'db' });
    expect(plan).toMatchObject({ ok: false, code: 'busy' });
  });

  it('says the copy by its server', async () => {
    const { plan } = await planDbSwitchover(fakeSwitchover({ row: { state: 'catchup', lagBytes: 0 } }).ctx, { stack: 'shop', cluster: 'db' });
    expect(plan).toMatchObject({ ok: false, code: 'not-streaming', reason: "wkr-2's copy is catchup, not streaming, so it can't take the writes yet." });
  });

  it('an unknown cluster is not found', async () => {
    await expect(planDbSwitchover(fakeSwitchover().ctx, { stack: 'shop', cluster: 'nope' })).rejects.toThrow(/not found/i);
  });
});

describe('startDbSwitchover — refuse before touching, else answer with the run', () => {
  it('a refusal is the error, and nothing was dispatched but the read', async () => {
    const f = fakeSwitchover({ row: { state: 'streaming', lagBytes: 64 << 20 } });
    await expect(startDbSwitchover(f.ctx, { stack: 'shop', cluster: 'db' }, f.io)).rejects.toThrow('64 MB behind');
    expect(f.calls.map((c) => c.cmd)).toEqual(['db.query']);
    expect(getDbSwitchoverRun(f.ctx, { stack: 'shop', cluster: 'db' })).toBeNull();
  });

  it('answers with the first view; the relay carries the rest to the end', async () => {
    const f = fakeSwitchover({ promote: 'yes' });
    const first = await startDbSwitchover(f.ctx, { stack: 'shop', cluster: 'db', target: 'shop_db-replica' }, f.io);
    expect([first.status, first.from, first.target, first.targetNodeId]).toEqual(['running', 'shop_db-primary', 'shop_db-replica', 'n2']);
    await new Promise((r) => setTimeout(r, 20));
    const last = getDbSwitchoverRun(f.ctx, { stack: 'shop', cluster: 'db' })!;
    expect(last.status).toBe('done');
    expect(last.steps.map((s) => s.status)).toEqual(['done', 'done', 'done', 'done', 'done']);
  });
});
