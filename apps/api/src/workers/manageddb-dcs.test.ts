import { describe, expect, it } from 'bun:test';
import { dcsToRemove } from './manageddb-reconcile';

/** The failover topology no longer runs an etcd member; a leftover one is torn down. */
describe('dcsToRemove', () => {
  it('a leftover -dcs member is removed, whatever the topology', () => {
    expect(dcsToRemove({ dcs: { name: 'qa-data_pg-dcs' } })).toBe('qa-data_pg-dcs');
  });
  it('nothing to remove when there is none', () => {
    expect(dcsToRemove({})).toBeNull();
  });
});
