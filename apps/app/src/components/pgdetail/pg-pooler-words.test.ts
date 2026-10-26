import { describe, expect, it } from 'bun:test';
import type { DbPoolerView } from '@swarmy/core';
import { MODE_WORDS, poolerChangeWords, poolerHeadline, poolerTech, trafficLine } from './pg-pooler-words';

const view = (over: Partial<DbPoolerView> = {}): DbPoolerView => ({
  stack: 'shop',
  cluster: 'main',
  declared: { mode: 'transaction', poolSize: 20 },
  service: 'shop_main-pooler',
  address: 'shop_main-pooler:6432',
  status: 'running',
  running: 1,
  desired: 1,
  target: 'shop_main-primary',
  writer: 'shop_main-primary',
  converging: false,
  traffic: null,
  apps: [],
  ...over,
});

describe('the pooler section words', () => {
  it('says plainly what transaction mode breaks', () => {
    expect(MODE_WORDS.transaction.sentence).toContain('prepared statements, LISTEN/NOTIFY, advisory locks');
    expect(MODE_WORDS.session.sentence).toContain('Every Postgres feature works');
  });

  it('a sentence per state: off, starting, on, moving after a switch-over, not answering', () => {
    expect(poolerHeadline(view({ declared: null, status: 'absent' }))).toEqual({ word: 'Off', tone: 'idle', sentence: 'Off. Apps connect to the main copy directly.' });
    expect(poolerHeadline(view({ status: 'absent', converging: true })).word).toBe('Starting');
    expect(poolerHeadline(view())).toEqual({ word: 'Online', tone: 'ok', sentence: 'On, in transaction mode: apps that go through it share up to 20 connections to main-primary.' });
    expect(poolerHeadline(view({ writer: 'shop_main-replica', converging: true })).sentence).toBe('Moving to the new main copy, main-replica: open transactions finish on the old one first.');
    expect(poolerHeadline(view({ status: 'failing' })).tone).toBe('bad');
    expect(poolerHeadline(view({ declared: null })).word).toBe('Turning off');
  });

  it('live numbers, or none (never a fake zero)', () => {
    expect(trafficLine(null, 20)).toBe('No live numbers right now.');
    expect(trafficLine({ clientsActive: 12, clientsWaiting: 1, serversActive: 4, serversIdle: 6, pools: 1 }, 20)).toBe(
      '12 clients connected · 1 waiting for a free connection · 10 of 20 server connections open',
    );
  });

  it('the tech line names the label and the auth; the change line says what restarts', () => {
    expect(poolerTech(view())).toBe(
      'swarmy.db.pooler={"mode":"transaction","poolSize":20} · shop_main-pooler → shop_main-primary:5432 · auth_query as swarmy_pooler (its own secret, unchanged by a password rotation)',
    );
    expect(poolerChangeWords(null, { mode: 'session', poolSize: 20 }, 0)).toContain('Nothing else restarts');
    expect(poolerChangeWords({ mode: 'session', poolSize: 20 }, null, 2)).toBe('2 apps go through it: connect them directly first.');
    expect(poolerChangeWords({ mode: 'session', poolSize: 20 }, { mode: 'session', poolSize: 40 }, 0)).toContain('a new one starts first');
  });
});
