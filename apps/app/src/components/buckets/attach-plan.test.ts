import { describe, expect, test } from 'bun:test';
import { attachCandidates, attachEnvLines, attachmentMap, attachedToast, shortName } from './attach-plan';

const svc = (name: string, stack: string, labels: Record<string, string> = {}) => ({ id: `id-${name}`, name, stack, labels });

describe('attachCandidates', () => {
  const services = [
    svc('storefront_web', 'storefront'),
    svc('storefront_api', 'storefront'),
    svc('storefront_db-primary', 'storefront', { 'swarmy.db.cluster': 'db' }),
    svc('storefront_cache', 'storefront', { 'swarmy.cache.engine': 'valkey' }),
    svc('swarmy-garage', 'swarmy-system', { 'swarmy.managed': 'true' }),
    svc('blog_ghost', 'blog'),
  ];

  test('only the app’s own services, never managed data members', () => {
    const c = attachCandidates('storefront', services, new Map());
    expect(c.map((x) => x.short)).toEqual(['api', 'web']);
    expect(c.every((x) => x.eligible)).toBe(true);
  });

  test('a service that already holds a bucket sits out, listed last with why', () => {
    const c = attachCandidates('storefront', services, new Map([['storefront_api', 'media']]));
    expect(c.map((x) => [x.short, x.eligible, x.reason])).toEqual([
      ['web', true, undefined],
      ['api', false, 'already uses media'],
    ]);
  });
});

describe('attachmentMap', () => {
  test('maps each attached service to its bucket; skips unloaded buckets', () => {
    const m = attachmentMap([{ name: 'media', attachments: [{ service: 'api' }] }, undefined, { name: 'exports', attachments: [] }]);
    expect([...m]).toEqual([['api', 'media']]);
  });
});

describe('attachEnvLines', () => {
  test('shows the five variables, with the key and secret minted on attach', () => {
    const lines = attachEnvLines({ endpoint: 'http://swarmy-garage:3900', region: 'swarmy', bucket: 'media' });
    expect(lines.map((l) => l.key)).toEqual(['S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY_FILE']);
    expect(lines[2]!.value).toBe('media');
    expect(lines[4]!.note).toContain('Docker secret');
  });
});

test('shortName strips the app prefix only', () => {
  expect(shortName('storefront', 'storefront_api')).toBe('api');
  expect(shortName('storefront', 'api')).toBe('api');
  expect(shortName('blog', 'storefront_api')).toBe('storefront_api');
});

test('attachedToast counts variables and services', () => {
  expect(attachedToast('media', 'storefront', 2)).toBe('media attached to storefront · 5 variables in 2 services');
  expect(attachedToast('media', 'blog', 1)).toBe('media attached to blog · 5 variables in 1 service');
});
