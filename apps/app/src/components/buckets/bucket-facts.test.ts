import { describe, expect, test } from 'bun:test';
import { attachedRows, copiesSay, deleteBlocked, memberWord, permWord, quotaPct } from './bucket-facts';

describe('permWord', () => {
  test('says what a key may do', () => {
    expect(permWord({ read: true, write: true, owner: false })).toBe('read-write');
    expect(permWord({ read: true, write: false, owner: false })).toBe('read');
    expect(permWord({ read: false, write: true, owner: false })).toBe('write-only');
    expect(permWord({ read: true, write: true, owner: true })).toBe('read-write · owner');
    expect(permWord({ read: false, write: false, owner: true })).toBe('owner');
    expect(permWord(undefined)).toBe('no access');
  });
});

describe('attachedRows', () => {
  test('joins each attachment with its key’s grant', () => {
    const rows = attachedRows({
      attachments: [
        { service: 'storefront_api', stack: 'storefront', accessKeyId: 'GK1', secretName: 's1' },
        { service: 'storefront_web', stack: 'storefront', accessKeyId: 'GK2', secretName: 's2' },
      ],
      keys: [
        { accessKeyId: 'GK1', name: 'a', permissions: { read: true, write: true, owner: false } },
        { accessKeyId: 'GK2', name: 'b', permissions: { read: true, write: false, owner: false } },
      ],
    });
    expect(rows.map((r) => [r.app, r.service, r.perm])).toEqual([
      ['storefront', 'api', 'read-write'],
      ['storefront', 'web', 'read'],
    ]);
  });
});

describe('deleteBlocked', () => {
  const att = { service: 'api', stack: 'storefront', accessKeyId: 'GK1', secretName: 's' };
  test('names both reasons', () => {
    expect(deleteBlocked({ objects: 212_904, attachments: [att, { ...att, service: 'web' }] })).toBe(
      'Can’t delete: holds 212,904 objects · attached to storefront',
    );
  });
  test('one object, no app', () => {
    expect(deleteBlocked({ objects: 1, attachments: [] })).toBe('Can’t delete: holds 1 object');
  });
  test('an empty, unattached bucket can go', () => {
    expect(deleteBlocked({ objects: 0, attachments: [] })).toBeNull();
  });
});

describe('copiesSay', () => {
  const on = (name: string) => ({ name, online: true, up: true });
  test('three copies on three servers', () => {
    expect(copiesSay(3, [on('a'), on('b'), on('c')])).toBe('Each file is kept on 3 servers. Any one can be lost and every file is still served.');
  });
  test('more servers than copies', () => {
    expect(copiesSay(2, [on('a'), on('b'), on('c')])).toContain('kept on 2 of these 3 servers');
  });
  test('one copy is said plainly', () => {
    expect(copiesSay(1, [on('a')])).toContain('If its server is lost');
  });
  test('a server not answering', () => {
    expect(copiesSay(3, [on('a'), on('b'), { name: 'c', online: false }])).toContain('1 of 3 servers is not answering');
  });
});

test('memberWord', () => {
  expect(memberWord({ name: 'a', online: true })).toEqual({ word: 'online', tone: 'ok' });
  expect(memberWord({ name: 'a', online: true, draining: true })).toEqual({ word: 'emptying', tone: 'warn' });
  expect(memberWord({ name: 'a', online: true, up: false })).toEqual({ word: 'not answering', tone: 'bad' });
});

test('quotaPct', () => {
  expect(quotaPct(18.4, 50)).toBe(36.8);
  expect(quotaPct(60, 50)).toBe(100);
  expect(quotaPct(10, null)).toBeNull();
});
