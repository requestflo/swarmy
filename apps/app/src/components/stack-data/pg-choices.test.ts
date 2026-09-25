import { describe, expect, test } from 'bun:test';
import { applySteps, choiceFacts, choiceLabels, cronWords, currentChoice, humanBytes, recommendedChoice, type PgClusterFacts } from './pg-choices';

const cluster = (over: Partial<PgClusterFacts> = {}): PgClusterFacts => ({
  name: 'db',
  topology: 'primary-replica',
  replicas: { desired: 1, running: 1 },
  members: [],
  pitr: false,
  rwHost: 'shop_db-primary',
  roHost: 'shop_db-replica',
  primary: { service: 'shop_db-primary', status: 'running' },
  ...over,
});

describe('currentChoice', () => {
  test('maps topology + replicas onto the three plain choices', () => {
    expect(currentChoice(cluster({ topology: 'single', replicas: { desired: 0, running: 0 } }))).toBe('one');
    expect(currentChoice(cluster({ replicas: { desired: 0, running: 0 } }))).toBe('one');
    expect(currentChoice(cluster())).toBe('standby');
    expect(currentChoice(cluster({ topology: 'failover' }))).toBe('auto');
    expect(currentChoice(cluster({ topology: 'geo' }))).toBeNull();
  });
  test('recommends the next step up only when it can honestly work', () => {
    expect(recommendedChoice('one', false)).toBe('standby');
    expect(recommendedChoice('standby', false)).toBeNull();
    expect(recommendedChoice('standby', true)).toBe('auto');
    expect(recommendedChoice('auto', true)).toBeNull();
  });
});

describe('cronWords', () => {
  test('says common schedules plainly', () => {
    expect(cronWords('0 3 * * *')).toBe('every night at 03:00');
    expect(cronWords('30 2 * * 0')).toBe('every Sunday at 02:30');
    expect(cronWords('0 */6 * * *')).toBe('every 6 hours');
    expect(cronWords('15 * * * *')).toBe('every hour');
    expect(cronWords(null)).toBeNull();
    expect(cronWords('0 3 1 * *')).toBe('on a schedule (0 3 1 * *)');
  });
  test('bytes read short', () => {
    expect(humanBytes('268435456')).toBe('256 MB');
    expect(humanBytes(4.1 * 1024 ** 3)).toBe('4.1 GB');
    expect(humanBytes(null)).toBeNull();
  });
});

describe('applying a choice', () => {
  test('failover gets a replica before the topology flips', () => {
    expect(applySteps('auto', { replicas: { desired: 0, running: 0 } })).toEqual([
      { kind: 'replicas', replicas: 1 },
      { kind: 'topology', topology: 'failover' },
    ]);
    expect(applySteps('standby', { replicas: { desired: 2, running: 2 } })).toEqual([{ kind: 'topology', topology: 'primary-replica' }]);
    expect(applySteps('one', { replicas: { desired: 2, running: 2 } })[0]).toEqual({ kind: 'topology', topology: 'single' });
  });
  test('labels match what the service stamps', () => {
    expect(choiceLabels('auto', { replicas: { desired: 2, running: 1 } })).toEqual({ 'swarmy.db.topology': 'failover', 'swarmy.db.replicas': '2' });
  });
  test('never promises no loss without the caught-up rule', () => {
    for (const ch of ['standby', 'auto'] as const) expect(choiceFacts(ch, cluster(), null).tech).toContain('replay_lsn');
    expect(choiceFacts('one', cluster({ pitr: true }), null).lose).toBe('a few minutes');
  });
});
