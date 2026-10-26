import { POOLER_DEFAULT, encodePoolerConfig, type DbPoolerView, type PoolerConfig, type PoolerMode, type PoolerTraffic } from '@swarmy/core';
import type { Tone } from '@/components/calm';
import { shortName } from './pg-topology';

/**
 * The words of the Postgres page's pooler section (board 39, "PgBouncer").
 * PURE — tested in pg-pooler-words.test.ts.
 */

/** Server connections per database the picker offers. */
export const POOL_SIZE_CHOICES: readonly number[] = [5, 10, 20, 40, 80];

export const MODE_WORDS: Record<PoolerMode, { label: string; sentence: string }> = {
  transaction: {
    label: 'Transaction',
    sentence:
      'Most sharing: a connection is lent for one transaction at a time. That breaks anything an app keeps on its session: prepared statements, LISTEN/NOTIFY, advisory locks, SET and temporary tables.',
  },
  session: {
    label: 'Session',
    sentence: 'Every Postgres feature works: an app keeps its connection for as long as it holds it open, so it shares less.',
  },
};

export interface PoolerHeadline {
  word: string;
  tone: Tone;
  sentence: string;
}

export function poolerHeadline(v: DbPoolerView): PoolerHeadline {
  const main = v.writer ? shortName(v.writer) : 'the main copy';
  if (!v.declared) {
    return v.status === 'absent'
      ? { word: 'Off', tone: 'idle', sentence: 'Off. Apps connect to the main copy directly.' }
      : { word: 'Turning off', tone: 'info', sentence: 'Turning off: swarmy is removing the pooler.' };
  }
  if (v.status === 'absent') {
    return { word: 'Starting', tone: 'info', sentence: `Starting: swarmy sets up the pooler’s own login on ${main}, then starts it.` };
  }
  if (v.status === 'failing' || v.status === 'stopped') {
    return { word: 'Not answering', tone: 'bad', sentence: 'Not answering. Apps that go through it can’t reach the database until it is back.' };
  }
  if (v.target && v.writer && v.target !== v.writer) {
    return { word: 'Moving', tone: 'info', sentence: `Moving to the new main copy, ${main}: open transactions finish on the old one first.` };
  }
  const mode = v.declared.mode === 'transaction' ? 'transaction' : 'session';
  return {
    word: v.converging ? 'Updating' : 'Online',
    tone: v.converging ? 'info' : 'ok',
    sentence: `On, in ${mode} mode: apps that go through it share up to ${v.declared.poolSize} connections to ${main}.`,
  };
}

/** "12 apps' connections now · 1 waiting · 10 of 20 server connections open". */
export function trafficLine(t: PoolerTraffic | null, poolSize: number): string {
  if (!t) return 'No live numbers right now.';
  const servers = t.serversActive + t.serversIdle;
  const clients = `${t.clientsActive} ${t.clientsActive === 1 ? 'client' : 'clients'} connected`;
  const waiting = t.clientsWaiting > 0 ? ` · ${t.clientsWaiting} waiting for a free connection` : '';
  return `${clients}${waiting} · ${servers} of ${poolSize} server ${poolSize === 1 ? 'connection' : 'connections'} open`;
}

/** Mono, Controls up. */
export function poolerTech(v: DbPoolerView): string {
  if (!v.declared) return 'swarmy.db.pooler unset · no pooler service';
  return `swarmy.db.pooler=${encodePoolerConfig(v.declared)} · ${v.service} → ${v.target ?? v.writer ?? '?'}:5432 · auth_query as swarmy_pooler (its own secret, unchanged by a password rotation)`;
}

/** What applying `next` will do, for the confirmation line. */
export function poolerChangeWords(current: PoolerConfig | null, next: PoolerConfig | null, apps: number): string {
  if (!next) return apps > 0 ? `${apps} ${apps === 1 ? 'app goes' : 'apps go'} through it: connect ${apps === 1 ? 'it' : 'them'} directly first.` : 'swarmy removes the pooler. Apps that connect directly are not touched.';
  if (!current) return 'swarmy starts a pooler on the private network, pointed at the main copy. Nothing else restarts; apps use it once you send them through it.';
  return 'swarmy restarts the pooler with the new setting: a new one starts first, then open transactions finish on the old one.';
}

export const DEFAULT_POOLER: PoolerConfig = POOLER_DEFAULT;
