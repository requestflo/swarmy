import { describe, expect, it } from 'bun:test';
import { planAppRestore } from '@swarmy/core';
import { appRestoreScopeOf, type ScopeService } from './appRestore.scope';
import { refusalWords } from './appRestore.words';

const svc = (name: string, over: Partial<ScopeService> = {}): ScopeService => ({
  name,
  stack: 'shop',
  mode: 'replicated',
  desired: 1,
  labels: {},
  volumes: [],
  ...over,
});

describe('appRestoreScopeOf', () => {
  const services: ScopeService[] = [
    svc('shop_web', { desired: 2, volumes: ['shop_uploads'] }),
    svc('shop_mariadb', { volumes: ['shop_db-data'] }),
    svc('shop_checkout-primary', { labels: { 'swarmy.db.cluster': 'checkout', 'swarmy.db.role': 'primary', 'swarmy.db.dataVolume': 'shop_checkout-primary-data' }, volumes: ['shop_checkout-primary-data'] }),
    svc('shop_checkout-replica', { labels: { 'swarmy.db.cluster': 'checkout', 'swarmy.db.role': 'replica' }, volumes: ['shop_checkout-replica-data'] }),
    svc('shop_sessions', { labels: { 'swarmy.cache.engine': 'valkey' }, volumes: ['shop_sessions-data'] }),
    svc('shop_agent', { mode: 'global', desired: 0, volumes: ['shop_agent-cache'] }),
    svc('shop_cron', { desired: 0 }),
    svc('blog_web', { stack: 'blog', volumes: ['blog_uploads'] }),
  ];
  const saved = ['shop_uploads', 'shop_db-data', 'shop_checkout-primary-data', 'shop_checkout-old-data', 'shop_sessions-data', 'shop_agent-cache', 'shop_gone'];

  it('restores the app’s own volumes and its Postgres, and stops only the plain services with copies running', () => {
    const scope = appRestoreScopeOf('shop', services, saved);
    expect(scope.volumes).toEqual(['shop_db-data', 'shop_gone', 'shop_uploads']);
    expect(scope.databases).toEqual(['checkout']);
    expect(scope.leftOut).toEqual([
      { volume: 'shop_agent-cache', why: 'global' },
      { volume: 'shop_checkout-old-data', why: 'database' },
      { volume: 'shop_checkout-primary-data', why: 'database' },
      { volume: 'shop_sessions-data', why: 'managed' },
    ]);
    expect(scope.stops).toEqual([
      { service: 'shop_mariadb', replicas: 1 },
      { service: 'shop_web', replicas: 2 },
    ]);
    expect(scope.keepsRunning.map((k) => `${k.service}:${k.why}`)).toEqual([
      'shop_agent:global',
      'shop_checkout-primary:database',
      'shop_checkout-replica:database',
      'shop_sessions:managed',
    ]);
  });
});

describe('refusalWords', () => {
  it('names each part that cannot go back, and when everything can', () => {
    const plan = planAppRestore({
      at: Date.parse('2026-10-22T14:00:00Z'),
      volumes: [{ volume: 'shop_uploads', saves: [{ id: 'v1', status: 'SUCCEEDED', startedAt: '2026-10-22T15:00:00Z' }] }, { volume: 'shop_media', saves: [] }],
      databases: [],
    });
    expect(refusalWords('shop', plan)).toBe(
      "Nothing was restored: shop_uploads only goes back to 2026-10-22 15:00 UTC and shop_media has no save yet, so shop can't all go back to 2026-10-22 14:00 UTC.",
    );
    expect(refusalWords('shop', planAppRestore({ at: 0, volumes: [], databases: [] }))).toBe('shop has no saved volumes or databases to restore.');
  });
});
