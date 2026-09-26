import { describe, expect, it } from 'bun:test';
import { parseIntents, type IntentWorld } from './intents';

const world: IntentWorld = {
  apps: [
    { name: 'storefront', hosts: ['shop.northwind.dev'] },
    { name: 'analytics', hosts: [] },
  ],
  parts: [
    { id: 's1', name: 'checkout', app: 'storefront', desired: 2 },
    { id: 's2', name: 'web', app: 'storefront', desired: 3 },
    { id: 's3', name: 'clickhouse', app: 'analytics', desired: 1 },
  ],
};
const ids = (q: string) => parseIntents(q, world).map((i) => i.id);

describe('parseIntents', () => {
  it('"undo analytics" puts back its last healthy version', () => {
    expect(ids('undo analytics')).toEqual(['rollback:analytics', 'go:releases:analytics']);
    expect(ids('roll back analytics')[0]).toBe('rollback:analytics');
  });

  it('"add a domain to shop" finds storefront by its address', () => {
    const [i] = parseIntents('add a domain to shop', world);
    expect(i?.action).toEqual({ kind: 'go', to: '/network/domains/new', search: { app: 'storefront' } });
  });

  it('carries the domain into the form', () => {
    for (const q of ['add journal.northwind.dev to storefront', 'add a domain journal.northwind.dev to shop', 'give shop a domain journal.northwind.dev']) {
      expect(ids(q)).toEqual(['domain:storefront:journal.northwind.dev']);
    }
  });

  it('restarts a part, or every part of an app', () => {
    expect(ids('restart checkout')).toEqual(['restart:s1']);
    expect(ids('restart storefront')).toEqual(['restart:s1', 'restart:s2']);
  });

  it('scales a part, and says nothing when it already runs that many', () => {
    const [i] = parseIntents('scale checkout to 4', world);
    expect(i?.action).toMatchObject({ kind: 'scale', to: 4 });
    expect(ids('run web 3 copies')).toEqual([]);
  });

  it('questions jump to the answers', () => {
    expect(ids('why is storefront slow')).toEqual(['go:obs:storefront', 'go:errors:storefront']);
  });

  it('ignores names it does not know and short input', () => {
    expect(ids('undo nothing-here')).toEqual([]);
    expect(ids('un')).toEqual([]);
  });
});
