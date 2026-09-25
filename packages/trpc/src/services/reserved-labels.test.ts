import { describe, expect, it } from 'bun:test';
import { reservedLabelViolations } from '@swarmy/core';
import { enforceAdmission } from './admission-gate';
import { isSystemOwned } from './system-service-deploy';

/** User specs can't pose as platform services or as managed data. */
const liveOf = (m: Record<string, Record<string, string>>) => (name: string) => m[name];
const rules = (specs: unknown[], live: Record<string, Record<string, string>> = {}) =>
  reservedLabelViolations(specs, liveOf(live)).map((v) => v.rule);

const managedDb = { 'swarmy.db.cluster': 'db', 'swarmy.db.role': 'primary', 'swarmy.db.engine': 'postgres' };
const attached = { 'com.docker.stack.namespace': 'shop', 'swarmy.cache.inject': 'kv', 'swarmy.cache.inject.var': 'REDIS_URL' };

describe('reserved labels', () => {
  it('refuses a user-supplied swarmy.system on any spec', () => {
    expect(rules([{ name: 'shop_web', labels: { 'swarmy.system': 'true' } }])).toEqual(['label.system']);
    // …even as "false" on an existing app: the key itself is reserved.
    expect(rules([{ name: 'shop_web', labels: { 'swarmy.system': 'false' } }], { shop_web: {} })).toEqual(['label.system']);
  });

  it('refuses managed-data labels on a NEW service, every family', () => {
    for (const k of ['swarmy.db.cluster', 'swarmy.cache.inject', 'swarmy.search.cluster', 'swarmy.vector.name']) {
      expect(rules([{ name: 'shop_web', labels: { [k]: 'x' } }])).toEqual(['label.managed-data']);
    }
  });

  it('refuses adding or changing them on an app swarmy did not make managed', () => {
    expect(rules([{ name: 'shop_web', labels: { 'swarmy.db.cluster': 'db' } }], { shop_web: { 'com.docker.stack.namespace': 'shop' } })).toEqual([
      'label.managed-data',
    ]);
    // An attached app may not re-point its inject label at another cluster.
    expect(rules([{ name: 'shop_web', labels: { ...attached, 'swarmy.cache.inject': 'other' } }], { shop_web: attached })).toEqual([
      'label.managed-data',
    ]);
  });

  it('legitimate: an attached app redeploys with its unchanged inject labels', () => {
    expect(rules([{ name: 'shop_web', labels: attached }], { shop_web: attached })).toEqual([]);
  });

  it('legitimate: editing an existing managed service (its labels may change)', () => {
    const edited = { ...managedDb, 'swarmy.db.backup.auto': 'off' };
    expect(rules([{ name: 'shop_db-primary', labels: edited }], { 'shop_db-primary': managedDb })).toEqual([]);
  });

  it('legitimate: rebuilding a live platform service unchanged, and plain apps', () => {
    expect(rules([{ name: 'swarmy-dns', labels: { 'swarmy.system': 'true' } }], { 'swarmy-dns': { 'swarmy.system': 'true' } })).toEqual([]);
    expect(rules([{ name: 'shop_web', labels: { 'swarmy.managed': 'true', app: 'x' } }])).toEqual([]);
  });

  it('enforceAdmission refuses (the wall; no override), reading the live service from the hub', async () => {
    const ctx = {
      activeOrgId: 'o',
      hub: { liveInventory: () => ({ services: [{ name: 'shop_web', labels: { 'com.docker.stack.namespace': 'shop' } }], containers: [] }) },
    } as never;
    await expect(
      enforceAdmission(
        ctx,
        { kind: 'stack.deploy', orgId: 'o', stackName: 'shop', specs: [{ name: 'shop_web', image: 'nginx', labels: { 'swarmy.cache.cluster': 'kv' } }], override: true },
        { targetType: 'stack', targetId: 'shop' },
      ),
    ).rejects.toThrow(/set by swarmy on managed data/);
    await expect(
      enforceAdmission(
        ctx,
        { kind: 'service.deploy', orgId: 'o', specs: [{ name: 'web', image: 'nginx', labels: { 'swarmy.system': 'true' } }], override: true },
        { targetType: 'service', targetId: 'web' },
      ),
    ).rejects.toThrow(/platform services/);
  });

  it('the system-deploy gate: an app attached to a cache is NOT system-owned; the managed service is', () => {
    expect(isSystemOwned({ name: 'shop_web', labels: attached })).toBe(false);
    expect(isSystemOwned({ name: 'shop_db-primary', labels: managedDb })).toBe(true);
  });
});
