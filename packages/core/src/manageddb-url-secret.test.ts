import { describe, expect, it } from 'bun:test';
import { SECRET_CONTENT_HASH_LABEL, pickUrlSecret, staleUrlSecrets, type ListedSecret } from './manageddb-url-secret';

/**
 * A URL secret is addressed by its content: the same URL reuses its version,
 * a different one (new host, new password) gets the next free version, so a
 * repoint never collides with a later rotation.
 */

const F = 'shop_main-pg-url';
const s = (name: string, hash?: string): ListedSecret => ({ name, labels: hash ? { [SECRET_CONTENT_HASH_LABEL]: hash } : {} });

describe('pickUrlSecret', () => {
  it('the first connect names the password version, as it always has', () => {
    expect(pickUrlSecret({ family: F, hash: 'h1', floor: 1, existing: [] })).toEqual({ name: `${F}__v1`, create: true });
    expect(pickUrlSecret({ family: F, hash: 'h1', floor: 3, existing: [] })).toEqual({ name: `${F}__v3`, create: true });
  });

  it('the same content reuses its version (every app wired the same way shares it)', () => {
    expect(pickUrlSecret({ family: F, hash: 'h1', floor: 1, existing: [s(`${F}__v1`, 'h1')] })).toEqual({ name: `${F}__v1`, create: false });
  });

  it('a new host: the next free version, never the one holding the old host', () => {
    expect(pickUrlSecret({ family: F, hash: 'h2', floor: 1, existing: [s(`${F}__v1`, 'h1')] })).toEqual({ name: `${F}__v2`, create: true });
  });

  it('a rotation after a repoint skips past the repoint’s version', () => {
    const existing = [s(`${F}__v1`, 'h1'), s(`${F}__v2`, 'h2')];
    expect(pickUrlSecret({ family: F, hash: 'h3', floor: 2, existing })).toEqual({ name: `${F}__v3`, create: true });
  });

  it('an old secret with no content label never matches; other families never count', () => {
    const existing = [s(`${F}__v1`), s('shop_main-pg-ro-url__v7', 'h1'), s('shop_main-pg-urlx__v9', 'h1')];
    expect(pickUrlSecret({ family: F, hash: 'h1', floor: 1, existing })).toEqual({ name: `${F}__v2`, create: true });
  });
});

describe('staleUrlSecrets', () => {
  it('every version of the kinds asked for, except the ones kept', () => {
    const listed = [s(`${F}__v1`), s(`${F}__v2`), s('shop_main-pg-ro-url__v1'), s('shop_main-pg-pool-url__v1'), s('shop_main-pg-password__v1'), s('blog_main-pg-url__v1')];
    expect(staleUrlSecrets({ stack: 'shop', cluster: 'main', kinds: ['url', 'ro-url'], listed, keep: new Set([`${F}__v2`]) })).toEqual([
      'shop_main-pg-ro-url__v1',
      `${F}__v1`,
    ]);
  });
});
