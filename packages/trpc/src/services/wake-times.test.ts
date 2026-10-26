import { beforeEach, describe, expect, it } from 'bun:test';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { _resetWakeTimes, recordWakeTime, serviceWakeTimes, wakeTimesFor } from './wake-times';

const svc: SwarmServiceInfo = {
  id: 'svc-1',
  name: 'shop_web',
  image: 'x:1',
  mode: 'replicated',
  desiredReplicas: 0,
  runningReplicas: 0,
  createdAt: 0,
  updatedAt: 0,
  labels: { 'com.docker.stack.namespace': 'shop', 'swarmy.scaleToZero.enabled': 'true' },
  networks: [],
  env: [],
  ports: [],
  secrets: [],
  configs: [],
};

const ctx = (orgId: string): OrgContext =>
  ({ activeOrgId: orgId, hub: { liveInventory: () => ({ services: [svc], containers: [] }) } }) as unknown as OrgContext;

describe('wake times', () => {
  beforeEach(() => _resetWakeTimes());

  it('reads the wakes the activator timed for this org’s service', () => {
    recordWakeTime('org', 'shop_web', 2_140, 1_000);
    recordWakeTime('org', 'shop_web', 1_960, 2_000);
    recordWakeTime('other', 'shop_web', 40_000, 3_000);
    const v = serviceWakeTimes(ctx('org'), 'svc-1');
    expect(v.samples).toBe(2);
    expect(v.typicalMs).toBe(2_050);
    expect(v.lastMs).toBe(1_960);
  });

  it('is empty before any wake, and ignores nonsense', () => {
    recordWakeTime('org', 'shop_web', Number.NaN);
    recordWakeTime('org', 'shop_web', -5);
    expect(wakeTimesFor('org', 'shop_web').samples).toBe(0);
  });

  it('refuses a service the org does not run', () => {
    expect(() => serviceWakeTimes(ctx('org'), 'nope')).toThrow();
  });
});
