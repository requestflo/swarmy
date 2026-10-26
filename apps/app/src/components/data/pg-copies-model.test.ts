import { describe, expect, it } from 'bun:test';
import { copyChips, writerDragKey } from './pg-copies-model';

const members = [
  { service: 'shop_db-replica', role: 'replica', desired: 2, running: 2 },
  { service: 'shop_db-primary', role: 'primary', desired: 1, running: 1 },
  { service: 'shop_db-dcs', role: 'dcs', desired: 1, running: 1 },
  { service: 'shop_db-replica-eu', role: 'replica', desired: 0, running: 0 },
];
const place = new Map([
  ['shop_db-primary', [{ id: 'n2', name: 'wkr-2' }]],
  ['shop_db-replica', [{ id: 'n3', name: 'mgr-1' }, { id: 'n1', name: 'wkr-1' }]],
]);

describe('copyChips — board 15’s copies by server', () => {
  it('a chip per copy per server, the writer first, standbys by server name; parked and non-Postgres members left out', () => {
    expect(copyChips(members, place).map((c) => `${c.role}:${c.server}`)).toEqual(['writer:wkr-2', 'standby:mgr-1', 'standby:wkr-1']);
  });

  it('while placement loads, one unplaced chip per member', () => {
    expect(copyChips(members, undefined).map((c) => `${c.role}:${c.server ?? '-'}`)).toEqual(['writer:-', 'standby:-']);
  });

  it('the writer drag key names its cluster', () => {
    expect(writerDragKey('shop', 'db')).toBe('shop/db');
  });
});
