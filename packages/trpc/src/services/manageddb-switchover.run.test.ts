import { afterEach, describe, expect, it } from 'bun:test';
import { DB_SWITCHOVER_LABEL, parseSwitchoverRequest } from '@swarmy/core';
import { fakeSwitchover, type FakeOpts } from './manageddb-switchover.fake';
import { runDbSwitchover } from './manageddb-switchover.run';
import { resetSwitchoverRuns, switchoverRunFor } from './manageddb-switchover.runs';

/**
 * The planned switchover's runner against a fake swarm whose `service.scale`
 * of the writer plays the reconcile's promotion pass. Every abort path gives
 * the writes back to the old writer; nothing is promoted twice.
 */

afterEach(() => resetSwitchoverRuns());

const IN = { stack: 'shop', cluster: 'db', target: 'shop_db-replica' };
const run = (o: FakeOpts = {}) => {
  const f = fakeSwitchover({ promote: 'yes', ...o });
  return { f, done: runDbSwitchover(f.ctx, IN, f.io, { pollMs: 1 }) };
};
const scales = (f: ReturnType<typeof fakeSwitchover>) =>
  f.calls.filter((c) => c.cmd === 'service.scale').map((c) => `${c.payload.service}→${c.payload.replicas}`);
const view = () => switchoverRunFor('org1', 'shop', 'db')!;

describe('runDbSwitchover — the happy path', () => {
  it('pauses, waits for 0 bytes, stops the writer under the request, rejoins it as a standby', async () => {
    const { f, done } = run({ pooler: true });
    const res = await done;
    expect(res).toMatchObject({ from: 'shop_db-primary', to: 'shop_db-replica', finalLsn: '0/3000000', rejoined: true });
    const writer = f.sql.filter((q) => q.startsWith('shop_db-primary:')).map((q) => q.slice('shop_db-primary: '.length));
    expect(writer).toEqual([
      'ALTER SYSTEM SET default_transaction_read_only = on',
      'SELECT pg_reload_conf()',
      expect.stringContaining('pg_terminate_backend(pid)'),
      'CHECKPOINT',
      'SELECT pg_current_wal_flush_lsn()',
    ]);
    // The stop carries the final position for the promotion pass to check against.
    const stamps = f.calls.filter((c) => c.cmd === 'service.updateLabels' && (c.payload.add as Record<string, string>)[DB_SWITCHOVER_LABEL]);
    expect(stamps.map((c) => parseSwitchoverRequest((c.payload.add as Record<string, string>)[DB_SWITCHOVER_LABEL]))).toEqual([
      { at: expect.any(String), target: 'shop_db-replica', copy: 'sw-n2' },
      { at: expect.any(String), target: 'shop_db-replica', copy: 'sw-n2', finalLsn: '0/3000000' },
    ]);
    expect(scales(f)).toEqual(['shop_db-primary→0', 'shop_db-primary→1']);
    expect(f.audit.filter((a) => a.startsWith('db.'))).toEqual(['db.switchover.start', 'db.switchover']);
    expect(view().status).toBe('done');
    expect(view().pausedSeconds).toBeGreaterThan(0);
  });

  it('an app wired straight to the writer: the repoint step waits until its URL names the new writer', async () => {
    const { f, done } = run({ app: 'direct' });
    await done;
    expect(f.services.find((s) => s.name === 'shop_api')!.labels['swarmy.db.inject.host']).toBe('shop_db-replica');
    expect(view().steps[3]).toMatchObject({ phase: 'repoint', status: 'done', message: 'The other copies, the pooler and shop_api follow the new writer.' });
  });

  it('a slow rejoin is a warning, never an undo', async () => {
    const { f, done } = run({ noRejoin: true });
    expect((await done).rejoined).toBe(false);
    expect(view().steps.at(-1)).toMatchObject({ phase: 'rejoin', status: 'warn' });
    expect(view().status).toBe('done');
    expect(scales(f)).toEqual(['shop_db-primary→0', 'shop_db-primary→1']);
  });

  it('a custom rejoin (the retire flow) replaces the restart in place', async () => {
    const f = fakeSwitchover({ promote: 'yes' });
    const seen: string[] = [];
    await runDbSwitchover(f.ctx, IN, f.io, { pollMs: 1, rejoin: async (m) => void seen.push(m.name) });
    expect(seen).toEqual(['shop_db-primary']);
    expect(scales(f)).toEqual(['shop_db-primary→0']);
  });
});

describe('runDbSwitchover — every refusal and abort', () => {
  it('refused before anything is touched', async () => {
    const { f, done } = run({ row: { state: 'catchup', lagBytes: 0 } });
    await expect(done).rejects.toThrow('not streaming');
    expect(f.calls.map((c) => c.cmd)).toEqual(['db.query']);
    expect(f.sql).toEqual([]);
  });

  it('a standby service holding two copies: the request names ONE copy, and the run says it comes back as that copy', async () => {
    const { f, done } = run({ shared: true });
    await done;
    const req = f.calls.filter((c) => c.cmd === 'service.updateLabels' && (c.payload.add as Record<string, string>)[DB_SWITCHOVER_LABEL]);
    expect(parseSwitchoverRequest((req.at(-1)!.payload.add as Record<string, string>)[DB_SWITCHOVER_LABEL])).toMatchObject({ target: 'shop_db-replica', copy: 'sw-n2' });
    expect(view().steps[2]!.message).toContain('It comes back as that one copy');
  });

  it('a copy marked for promotion at the deadline wins: the old writer is never started again', async () => {
    const f = fakeSwitchover({ promote: 'marked' });
    const res = await runDbSwitchover(f.ctx, IN, f.io, { pollMs: 1, timeouts: { promoteMs: 5_000, repointMs: 1_000, rejoinMs: 1_000 } });
    expect(res.rejoined).toBe(false);
    expect(scales(f)).toEqual(['shop_db-primary→0']);
    expect(f.sql.some((q) => q.includes('RESET default_transaction_read_only'))).toBe(false);
  });

  it('the copy never catches up: writes resume, the label goes, nothing stops', async () => {
    const { f, done } = run({ lagStuck: true });
    await expect(done).rejects.toThrow('256 bytes behind the paused main copy');
    expect(scales(f)).toEqual([]);
    expect(f.frozen()).toBe(false);
    expect(f.primary.labels[DB_SWITCHOVER_LABEL]).toBeUndefined();
    expect(view()).toMatchObject({ status: 'aborted' });
    expect(view().steps[1]).toMatchObject({ phase: 'catch-up', status: 'failed' });
    expect(f.audit.filter((a) => a.startsWith('db.'))).toEqual(['db.switchover.start', 'db.switchover.abort']);
  });

  it('pausing fails part-way: writes resume', async () => {
    const { f, done } = run({ failAt: 'CHECKPOINT' });
    await expect(done).rejects.toThrow('exec exited 1');
    expect(f.frozen()).toBe(false);
    expect(f.primary.labels[DB_SWITCHOVER_LABEL]).toBeUndefined();
    expect(view().steps[0]).toMatchObject({ phase: 'pause', status: 'failed' });
  });

  it('an unreadable final position aborts before anything stops', async () => {
    const { f, done } = run({ flushLsn: 'ERROR: nope' });
    await expect(done).rejects.toThrow("couldn't read the main copy's last position");
    expect(scales(f)).toEqual([]);
    expect(f.frozen()).toBe(false);
  });

  it('the promotion pass holds: the old writer takes the writes back', async () => {
    const { f, done } = run({ promote: 'hold' });
    await expect(done).rejects.toThrow('held the switch');
    expect(scales(f)).toEqual(['shop_db-primary→0', 'shop_db-primary→1']);
    expect(f.frozen()).toBe(false);
    expect(f.primary.labels[DB_SWITCHOVER_LABEL]).toBeUndefined();
    expect(view().steps[2]).toMatchObject({ phase: 'promote', status: 'failed' });
  });

  it('the promotion never comes in time: the old writer takes the writes back', async () => {
    const f = fakeSwitchover({ promote: 'never' });
    await expect(runDbSwitchover(f.ctx, IN, f.io, { pollMs: 1, timeouts: { promoteMs: 5_000 } })).rejects.toThrow('in time');
    expect(scales(f)).toEqual(['shop_db-primary→0', 'shop_db-primary→1']);
    expect(f.frozen()).toBe(false);
  });

  it('a promotion that landed at the deadline wins: the old writer is never started as a second writer', async () => {
    const f = fakeSwitchover({ promote: 'never', promotedUnlabelled: true });
    const res = await runDbSwitchover(f.ctx, IN, f.io, { pollMs: 1, timeouts: { promoteMs: 5_000, repointMs: 1_000, rejoinMs: 1_000 } });
    expect(res.to).toBe('shop_db-replica');
    expect(f.sql.some((q) => q.includes('RESET default_transaction_read_only'))).toBe(false);
    // Not repointed yet, so not started: its old spec is a writer's.
    expect(scales(f)).toEqual(['shop_db-primary→0']);
    expect(view().steps.map((s) => s.status)).toEqual(['done', 'done', 'done', 'warn', 'warn']);
  });
});
