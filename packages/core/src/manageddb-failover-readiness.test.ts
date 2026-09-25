import { describe, expect, test } from 'bun:test';
import { failoverReadiness } from './manageddb-failover';

describe('failoverReadiness (QA-058)', () => {
  test('one server: refused, and says why', () => {
    const r = failoverReadiness({ readyNodes: 1, replicas: 1, primaryPinned: true });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain('at least 2 servers');
  });
  test('no replica to promote: refused', () => {
    expect(failoverReadiness({ readyNodes: 3, replicas: 0, primaryPinned: true })).toMatchObject({ ok: false });
  });
  test('unpinned primary storage (replica could share its server): refused', () => {
    const r = failoverReadiness({ readyNodes: 3, replicas: 1, primaryPinned: false });
    expect(!r.ok && r.reason).toContain('Migrate storage');
  });
  test('2+ servers, a replica, pinned primary: offered, stating what it survives', () => {
    const r = failoverReadiness({ readyNodes: 2, replicas: 1, primaryPinned: true });
    expect(r.ok).toBe(true);
    expect(r.ok && r.survives).toContain("primary's server");
  });
});
