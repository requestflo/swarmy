import { describe, expect, it } from 'bun:test';
import { DB_SWITCHOVER_LABEL, encodeSwitchoverRequest } from '@swarmy/core';
import { plannedRequest, promotionRecord, thawStaleSwitchover, type ThawSeams } from './manageddb-switchover';

const AT = '2026-10-26T10:00:00.000Z';
const NOW = Date.parse(AT);
const label = (at = AT) => ({ [DB_SWITCHOVER_LABEL]: encodeSwitchoverRequest({ at, target: 'shop_db-replica', finalLsn: '0/3000000' }) });

function seams(exitCode: number | null = 0) {
  const calls: string[] = [];
  const s: ThawSeams = {
    sql: async (q) => {
      calls.push(q);
      return exitCode === null ? null : { exitCode };
    },
    dropLabel: async () => calls.push('drop'),
    audit: async (m) => calls.push(`audit ${JSON.stringify(m)}`),
  };
  return { s, calls };
}

describe('plannedRequest', () => {
  it('reads a fresh request, ignores a stale or missing one', () => {
    expect(plannedRequest(label(), NOW + 1000)).toEqual({ at: AT, target: 'shop_db-replica', finalLsn: '0/3000000' });
    expect(plannedRequest(label(), NOW + 11 * 60_000)).toBeNull();
    expect(plannedRequest({}, NOW)).toBeNull();
  });
});

describe('promotionRecord — a planned promotion pages nobody', () => {
  it('planned: a warning on the timeline, an info event', () => {
    const r = promotionRecord(true);
    expect([r.kind, r.severity, r.signal, r.lead(false)]).toEqual(['db.switchover', 'warning', 'info', 'Planned switch-over']);
  });
  it('failover: critical, as before', () => {
    const r = promotionRecord(false);
    expect([r.kind, r.severity, r.signal, r.lead(true), r.lead(false)]).toEqual(['db.failover', 'critical', 'critical', 'Confirmed failover', 'Automatic failover']);
  });
});

describe('thawStaleSwitchover — a run that died while writes were paused', () => {
  const writer = (labels: Record<string, string>) => ({ name: 'shop_db-primary', labels });

  it('a fresh request is the run in flight: nothing happens', async () => {
    const t = seams();
    expect(await thawStaleSwitchover(writer(label()), NOW + 60_000, t.s)).toBe(false);
    expect(t.calls).toEqual([]);
  });

  it('a stale one: writes back on, label dropped, audited', async () => {
    const t = seams();
    expect(await thawStaleSwitchover(writer(label()), NOW + 11 * 60_000, t.s)).toBe(true);
    expect(t.calls).toEqual([
      'ALTER SYSTEM RESET default_transaction_read_only',
      'SELECT pg_reload_conf()',
      'drop',
      `audit ${JSON.stringify({ writer: 'shop_db-primary', pausedAt: AT, target: 'shop_db-replica' })}`,
    ]);
  });

  it('keeps the label when the reset did not run, so the next tick retries', async () => {
    for (const code of [null, 1]) {
      const t = seams(code);
      expect(await thawStaleSwitchover(writer(label()), NOW + 11 * 60_000, t.s)).toBe(false);
      expect(t.calls).toEqual(['ALTER SYSTEM RESET default_transaction_read_only']);
    }
  });

  it('no label: nothing to do', async () => {
    const t = seams();
    expect(await thawStaleSwitchover(writer({}), NOW, t.s)).toBe(false);
    expect(t.calls).toEqual([]);
  });
});
