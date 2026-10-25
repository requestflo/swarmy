import { describe, expect, it } from 'bun:test';
import { pickableEngines } from './db-backup-format';

describe('the backup engine picker', () => {
  const values = (o: Parameters<typeof pickableEngines>[0]) => pickableEngines(o).map((e) => e.value);

  it('hides pgBackRest until the controller has an operator-supplied image (and while loading)', () => {
    expect(values(undefined)).toEqual(['pg_dump', 'pg_dumpall', 'snapshot-from-replica', 'wal-g']);
    expect(values([{ engine: 'pgbackrest', offered: false }, { engine: 'wal-g', offered: true }])).not.toContain('pgbackrest');
  });

  it('shows it once the controller offers it', () => {
    expect(values([{ engine: 'pgbackrest', offered: true }])).toContain('pgbackrest');
  });
});
