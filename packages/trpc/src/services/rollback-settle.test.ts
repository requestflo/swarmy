import { describe, expect, it } from 'bun:test';
import { rollbackSettle, sameImage, type SettleLive } from './rollback-settle';

const svc = (name: string, image: string, over: Partial<SettleLive> = {}): SettleLive => ({
  name, image, desiredReplicas: 2, runningReplicas: 2, updateStatus: 'completed', ...over,
});
const WANT = [
  { name: 'shop_web', image: 'ghcr.io/nw/web:1.8.2' },
  { name: 'shop_db', image: 'postgres:16' },
];

describe('sameImage', () => {
  it('matches the tag Docker pinned with a digest, and Hub shorthands', () => {
    expect(sameImage('ghcr.io/nw/web:1.8.2', 'ghcr.io/nw/web:1.8.2@sha256:abc')).toBe(true);
    expect(sameImage('postgres:16', 'docker.io/library/postgres:16@sha256:def')).toBe(true);
    expect(sameImage('ghcr.io/nw/web:1.8.2', 'ghcr.io/nw/web:1.9.0@sha256:abc')).toBe(false);
    expect(sameImage('ghcr.io/nw/web:1.8.2', 'ghcr.io/nw/api:1.8.2')).toBe(false);
  });

  it('a digest-pinned spec needs that digest', () => {
    expect(sameImage('ghcr.io/nw/web@sha256:abc', 'ghcr.io/nw/web:1.8.2@sha256:abc')).toBe(true);
    expect(sameImage('ghcr.io/nw/web@sha256:abc', 'ghcr.io/nw/web:1.8.2@sha256:fff')).toBe(false);
  });
});

describe('rollbackSettle', () => {
  it('is healthy once every part runs the put-back image with all its copies', () => {
    expect(rollbackSettle([svc('shop_web', 'ghcr.io/nw/web:1.8.2@sha256:a'), svc('shop_db', 'postgres:16'), svc('other', 'x:1')], WANT)).toBe('healthy');
  });

  it('is still rolling while a part runs the old image, updates, is short a copy or is missing', () => {
    const db = svc('shop_db', 'postgres:16');
    expect(rollbackSettle([svc('shop_web', 'ghcr.io/nw/web:1.9.0'), db], WANT)).toBe('rolling');
    expect(rollbackSettle([svc('shop_web', 'ghcr.io/nw/web:1.8.2', { updateStatus: 'updating' }), db], WANT)).toBe('rolling');
    expect(rollbackSettle([svc('shop_web', 'ghcr.io/nw/web:1.8.2', { runningReplicas: 1 }), db], WANT)).toBe('rolling');
    expect(rollbackSettle([db], WANT)).toBe('rolling');
  });

  it('a global part needs one copy running', () => {
    const g = svc('shop_web', 'ghcr.io/nw/web:1.8.2', { desiredReplicas: undefined, runningReplicas: 0 });
    expect(rollbackSettle([g, svc('shop_db', 'postgres:16')], WANT)).toBe('rolling');
    expect(rollbackSettle([{ ...g, runningReplicas: 3 }, svc('shop_db', 'postgres:16')], WANT)).toBe('healthy');
  });

  it('fails when Docker paused or undid the update', () => {
    for (const updateStatus of ['paused', 'rollback_started', 'rollback_completed'] as const) {
      expect(rollbackSettle([svc('shop_web', 'ghcr.io/nw/web:1.8.2', { updateStatus }), svc('shop_db', 'postgres:16')], WANT)).toBe('failed');
    }
  });

  it('a release with nothing to wait for is healthy', () => {
    expect(rollbackSettle([], [])).toBe('healthy');
  });
});
