import { describe, expect, it } from 'bun:test';
import { classifySql } from './studio/classify';
import { PG_REPLICATION_SQL, matchStandbyTask, parseReplicationRows } from './manageddb-replication';

const COLUMNS = ['name', 'addr', 'state', 'sync_state', 'sent_lsn', 'replay_lsn', 'primary_lsn', 'lag_bytes', 'lag_seconds'];

describe('PG_REPLICATION_SQL', () => {
  it('is a plain read the studio runs as one', () => {
    const c = classifySql(PG_REPLICATION_SQL, 'postgres');
    expect(c.blocked).toBeUndefined();
    expect(c.class).toBe('read');
  });
});

describe('parseReplicationRows', () => {
  it('reads one row per standby, with the primary LSN', () => {
    const r = parseReplicationRows({
      columns: COLUMNS,
      rows: [
        ['3f2a9c1b7d4e', '10.0.4.7/32', 'streaming', 'async', '0/3000148', '0/3000060', '0/3000148', '232', '0.4'],
        ['8c1d0e2f3a4b', '10.0.4.9/32', 'streaming', 'async', '0/3000148', '0/3000148', '0/3000148', 0, null],
      ],
    });
    expect(r.primaryLsn).toBe('0/3000148');
    expect(r.standbys).toEqual([
      { name: '3f2a9c1b7d4e', addr: '10.0.4.7/32', state: 'streaming', syncState: 'async', sentLsn: '0/3000148', replayLsn: '0/3000060', lagBytes: 232, lagSeconds: 0.4 },
      { name: '8c1d0e2f3a4b', addr: '10.0.4.9/32', state: 'streaming', syncState: 'async', sentLsn: '0/3000148', replayLsn: '0/3000148', lagBytes: 0, lagSeconds: null },
    ]);
  });

  it('keeps the primary LSN when no standby is connected (the LEFT JOIN row)', () => {
    const r = parseReplicationRows({ columns: COLUMNS, rows: [[null, null, null, null, null, null, '0/5A1B2C3', null, null]] });
    expect(r).toEqual({ primaryLsn: '0/5A1B2C3', standbys: [] });
  });

  it('never invents a number: blanks and junk read as not measured', () => {
    const r = parseReplicationRows({ columns: COLUMNS, rows: [['pg_basebackup', '', 'backup', 'async', '', '', '0/1', '', 'n/a']] });
    expect(r.standbys[0]).toMatchObject({ name: 'pg_basebackup', addr: null, replayLsn: null, lagBytes: null, lagSeconds: null });
  });
});

describe('matchStandbyTask', () => {
  const tasks = [
    { containerId: '3f2a9c1b7d4e5f60718293a4b5c6d7e8f9', service: 'shop_db-replica', nodeId: 'n-wkr-1' },
    { containerId: '8c1d0e2f3a4b5c6d7e8f90a1b2c3d4e5f6', service: 'shop_db-replica', nodeId: 'n-mgr-2' },
  ];
  it('matches the swarm hostname (12-hex container id prefix)', () => {
    expect(matchStandbyTask('8c1d0e2f3a4b', tasks)?.nodeId).toBe('n-mgr-2');
  });
  it('matches nothing for a name that is not a container id', () => {
    expect(matchStandbyTask('pg_basebackup', tasks)).toBeNull();
    expect(matchStandbyTask('3f2a', tasks)).toBeNull();
    expect(matchStandbyTask('ffffffffffff', tasks)).toBeNull();
  });
});
