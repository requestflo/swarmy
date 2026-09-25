import { describe, expect, it } from 'bun:test';
import { dcsSpec } from './manageddb-reconcile';

/** QA-058: the DCS member keeps its data and stays off the primary's server. */
const c = { base: 'qa-data_pg', stack: 'qa-data', cluster: 'pg' } as never;

describe('dcsSpec', () => {
  it('persists its data on a volume', () => {
    expect(dcsSpec(c).mounts).toEqual([{ type: 'volume', source: 'qa-data_pg-dcs-data', target: '/etcd-data' }]);
  });
  it('multi-server: never on the primary’s server', () => {
    expect(dcsSpec(c, 'node-a', true).placement).toEqual({ constraints: ['node.id != node-a'] });
  });
  it('single server (nowhere else to go) or an unpinned primary: no constraint', () => {
    expect(dcsSpec(c, 'node-a', false).placement).toBeUndefined();
    expect(dcsSpec(c, undefined, true).placement).toBeUndefined();
  });
});
