import { describe, expect, test } from 'bun:test';
import type { NodeSummary } from '@swarmy/core';
import type { PgClusterFacts } from '@/components/stack-data/pg-choices';
import { outageScope, simulateOutage, simWords } from './pg-failover-sim';
import { modeFacts, type ModeContext } from './pg-mode-facts';
import { pgTopology, type PgTopoMember } from './pg-topology';

const node = (id: string, region: string | null): NodeSummary => ({ id, name: id, region, status: 'online' }) as NodeSummary;
const W1 = node('wkr-1', 'us-east');
const M1 = node('mgr-1', 'us-east');
const M2 = node('mgr-2', 'eu-west');

const members: PgTopoMember[] = [
  { service: 'shop_db-primary', role: 'primary', status: 'running', desired: 1, running: 1 },
  { service: 'shop_db-replica', role: 'replica', status: 'degraded', desired: 2, running: 1, lagSeconds: 14.2 },
];
const place = new Map([
  ['shop_db-primary', [W1]],
  ['shop_db-replica', [M2]],
]);
const cluster: PgClusterFacts = {
  name: 'db',
  topology: 'primary-replica',
  replicas: { desired: 2, running: 1 },
  members,
  pitr: false,
  rwHost: 'shop_db-primary',
  roHost: 'shop_db-replica',
  primary: { service: 'shop_db-primary', status: 'running' },
  maxLagSeconds: 14.2,
};

describe('pgTopology', () => {
  const base = { current: 'primary-replica' as const, members, place, heldTarget: null, tech: false };
  test('draws each member on its server, a missing copy dashed, the lag on the line', () => {
    const { columns, links } = pgTopology({ ...base, mode: 'primary-replica' });
    expect(columns[0]!.map((b) => [b.title, b.chip])).toEqual([['wkr-1', 'main copy']]);
    expect(columns[1]!.map((b) => [b.title, b.stat, !!b.ghost])).toEqual([
      ['mgr-2', '14 s behind', false],
      ['not running', undefined, true],
    ]);
    expect(links[0]).toMatchObject({ label: 'every change', tone: 'warn' });
  });
  test('one copy greys the standbys out; geo adds a dashed region copy', () => {
    expect(pgTopology({ ...base, mode: 'single' }).columns[1]!.every((b) => b.ghost)).toBe(true);
    expect(pgTopology({ ...base, mode: 'geo' }).columns[1]!.at(-1)).toMatchObject({ title: 'a copy in another region', ghost: true });
  });
  test('failover flags a standby that shares the main server', () => {
    const shared = new Map([...place, ['shop_db-replica', [W1]]]);
    const box = pgTopology({ ...base, mode: 'failover', place: shared }).columns[1]![0]!;
    expect(box).toMatchObject({ stat: 'moves off wkr-1', statTone: 'warn' });
  });
  test('a held switch-over marks the main copy down and the target held', () => {
    const { columns } = pgTopology({ ...base, mode: 'primary-replica', heldTarget: 'shop_db-replica' });
    expect(columns[0]![0]).toMatchObject({ chip: 'down', tone: 'bad' });
    expect(columns[1]![0]).toMatchObject({ chip: 'held' });
  });
});

describe('simulateOutage', () => {
  const scope = outageScope([W1], [W1, M1, M2])!;
  test('takes the main copy’s region away', () => {
    expect(scope).toEqual({ label: 'us-east', kind: 'region', serverIds: ['wkr-1', 'mgr-1'] });
    expect(outageScope([node('solo', null)], [])).toMatchObject({ label: 'solo', kind: 'server' });
  });
  test('runs decideFailover three ways on the survivors', () => {
    const sim = simulateOutage('primary-replica', members, place, scope, 1_000);
    expect(sim.primaryDown).toBe(true);
    expect(sim.caughtUp).toMatchObject({ kind: 'promote', target: 'shop_db-replica', behindBytes: 0 });
    expect(sim.behind).toMatchObject({ kind: 'confirm', behindBytes: 1 });
    expect(sim.unknown.kind).toBe('confirm');
    const words = simWords(sim, () => 'mgr-2');
    expect(words[0]!.lead).toBe('If the copy on mgr-2 has every change, it takes over by itself.');
    expect(words[1]!.tone).toBe('warn');
  });
  test('no survivor → waits; one copy → never; primary elsewhere → nothing switches', () => {
    const all = new Map([...place, ['shop_db-replica', [M1]]]);
    expect(simulateOutage('failover', members, all, scope, 1).caughtUp.kind).toBe('wait');
    expect(simWords(simulateOutage('single', members, place, scope, 1), String)[0]!.lead).toBe('Nothing to switch over to.');
    const eu = { label: 'eu-west', kind: 'region' as const, serverIds: ['mgr-2'] };
    const sim = simulateOutage('primary-replica', members, place, eu, 1);
    expect(sim.primaryDown).toBe(false);
    expect(simWords(sim, String)[0]!.rest).toBe('A standby copy there stops serving reads until then.');
  });
});

describe('modeFacts', () => {
  const ctx: ModeContext = { primary: 'wkr-1', standbys: 'mgr-2', sameServer: false, region: 'us-east', drill: null, ref: 'shop/db', now: Date.parse('2026-10-23T12:00:00Z') };
  test('one copy uses the last save’s real age and the drill’s real time', () => {
    const b = { cron: '0 3 * * *', retentionDays: 7, lastSizeBytes: null, lastBackupAt: '2026-10-23T03:00:00Z', lastStatus: 'succeeded', pitr: false };
    const f = modeFacts('single', cluster, b, { ...ctx, drill: { rtoMs: 8 * 60_000, target: 'shop/other' } });
    expect(f.lose).toBe('up to 9h 0m of changes, the last save’s age');
    expect(f.down).toBe('about 8m to restore, from a drill on shop/other');
    expect(modeFacts('single', cluster, null, ctx).down).toBe('until a restore finishes · a drill would time it');
  });
  test('standby modes reuse the Data tab’s words and name the servers', () => {
    expect(modeFacts('primary-replica', cluster, null, ctx).say).toContain('A standby copy on mgr-2 follows every change.');
    expect(modeFacts('primary-replica', cluster, null, { ...ctx, sameServer: true }).say).toContain('It shares wkr-1 with the main copy');
    expect(modeFacts('failover', cluster, null, ctx).down).toBe('about 30 s');
  });
});
