import { describe, expect, test } from 'bun:test';
import type { NodeSummary } from '@swarmy/core';
import { behindWords, standbyBoxStats, standbyRows, type PgStandby } from './pg-replication';
import { pgTopology } from './pg-topology';

const sb = (over: Partial<PgStandby> = {}): PgStandby => ({
  name: '3f2a9c1b7d4e',
  service: 'shop_db-replica',
  nodeId: 'mgr-2',
  state: 'streaming',
  syncState: 'async',
  sentLsn: '0/3000148',
  replayLsn: '0/3000060',
  lagBytes: 232,
  lagSeconds: 0.4,
  ...over,
});
const nodes = [{ id: 'mgr-2', name: 'mgr-2', region: 'eu-west', status: 'online' }] as NodeSummary[];

describe('behindWords', () => {
  test('caught up, in step, behind: bytes decide, seconds only add', () => {
    expect(behindWords(sb({ lagBytes: 0, lagSeconds: null }))).toMatchObject({ short: 'caught up', tone: 'ok' });
    expect(behindWords(sb())).toMatchObject({ short: '232 B behind, 0.4 s', word: 'in step', tone: 'ok' });
    expect(behindWords(sb({ lagBytes: 40 * 1024 * 1024, lagSeconds: 14.2 }))).toMatchObject({ short: '40.0 MB behind, 14 s', word: 'behind', tone: 'warn' });
    expect(behindWords(sb({ lagBytes: 4096, lagSeconds: 6 })).tone).toBe('warn');
  });

  test('a clone in flight and an unmeasured copy are never called caught up', () => {
    expect(behindWords(sb({ state: 'backup', lagBytes: null }))).toMatchObject({ word: 'copying', tone: 'info' });
    expect(behindWords(sb({ lagBytes: null, lagSeconds: null }))).toMatchObject({ short: 'not measured yet', tone: 'idle' });
  });
});

describe('standbyRows', () => {
  test('one row per copy, named by its server, the LSNs only in the tech line', () => {
    const [row] = standbyRows([sb()], nodes);
    expect([row!.name, row!.sub, row!.word]).toEqual(['mgr-2', 'eu-west', 'in step']);
    expect(row!.say).not.toMatch(/replica|lsn/i);
    expect(row!.tech).toBe('db-replica · replay_lsn 0/3000060 · sent 0/3000148 · 232 B · replay_lag 0.4 s · streaming · async · task 3f2a9c1b7d4e');
  });

  test('a row with no task keeps its own name', () => {
    expect(standbyRows([sb({ name: 'pg_basebackup', service: null, nodeId: null, state: 'backup' })], nodes)[0]!.name).toBe('pg_basebackup');
  });
});

describe('the diagram reads the per-copy figure', () => {
  test('a measured copy shows bytes and seconds in its box at Summary', () => {
    const { columns } = pgTopology({
      mode: 'primary-replica',
      current: 'primary-replica',
      members: [
        { service: 'shop_db-primary', role: 'primary', status: 'running', desired: 1, running: 1 },
        { service: 'shop_db-replica', role: 'replica', status: 'running', desired: 1, running: 1, lagSeconds: 0 },
      ],
      place: new Map([['shop_db-primary', [{ id: 'wkr-1', name: 'wkr-1' } as NodeSummary]], ['shop_db-replica', nodes]]),
      heldTarget: null,
      tech: false,
      behind: standbyBoxStats([sb({ lagBytes: 40 * 1024 * 1024, lagSeconds: 14.2 })]),
    });
    expect(columns[1]!.map((b) => [b.stat, b.statTone])).toEqual([['40.0 MB behind, 14 s', 'warn']]);
  });
});
