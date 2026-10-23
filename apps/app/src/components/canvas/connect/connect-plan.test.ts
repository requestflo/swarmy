import { describe, expect, test } from 'bun:test';
import type { DataNodeSpec } from '../data-nodes';
import { planConnect, reachWords, storeWords } from './connect-plan';

const store = (kind: DataNodeSpec['kind'], name: string, attached: string[] = []): DataNodeSpec => ({
  id: `data:${kind}:${name}`,
  kind,
  name,
  sub: kind,
  tech: kind,
  metric: null,
  tone: null,
  attached,
  env: [
    { key: 'REDIS_URL', value: 'redis://storefront_main-cache:6379' },
    { key: 'REDIS_PASSWORD_FILE', value: '/run/secrets/x' },
  ],
});

describe('planConnect', () => {
  test('says what it adds and that the part restarts', () => {
    const p = planConnect('worker', store('cache', 'main'), []);
    expect(p.title).toBe('worker → cache main');
    expect(p.say).toBe('swarmy adds 2 variables to worker and restarts it to pick them up.');
    expect(p.blocked).toBeNull();
    expect(p.undoable).toBe(true);
    expect(p.tech).toContain('cache.attachToService');
  });

  test('already wired → blocked', () => {
    const s = store('cache', 'main', ['web']);
    expect(planConnect('web', s, [s]).blocked).toBe('web already uses cache main. Nothing to add.');
  });

  test('one store of a kind per part', () => {
    const a = store('cache', 'main', ['web']);
    const b = store('cache', 'sessions');
    expect(planConnect('web', b, [a, b]).blocked).toContain('already uses cache main');
    expect(planConnect('api', b, [a, b]).blocked).toBeNull();
  });

  test('Postgres has no detach, so no Undo', () => {
    const p = planConnect('web', store('postgres', 'checkout'), []);
    expect(p.undoable).toBe(false);
    expect(p.tech).toStartWith('db.inject');
    expect(storeWords({ kind: 'postgres', name: 'checkout' })).toBe('Postgres checkout');
  });
});

describe('reachWords', () => {
  test('names the address the other part answers on', () => {
    const e = {
      stack: 'storefront',
      connectedApps: [],
      resources: [],
      services: [{ service: 'storefront_api', short: 'api', ports: [8080], names: [{ host: 'api', port: 8080, scope: 'app' as const }] }],
    };
    expect(reachWords('web', 'api', e)).toBe('web and api are parts of the same app, so web already reaches api at api:8080. There is nothing to connect.');
    expect(reachWords('web', 'gone', e)).toContain('already reaches gone. There');
  });
});
