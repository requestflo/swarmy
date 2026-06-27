import { describe, expect, it } from 'bun:test';
import {
  computeRecordHealth,
  healthySignature,
  planReconcile,
  type ReconcileRecord,
  type RegionHealth,
} from './geodns-reconcile.core';

function rec(id: string, region: string, healthy: boolean): ReconcileRecord {
  return { id, host: 'app.example.com', region, targetIngress: `ip-${id}`, healthy };
}

function health(entries: Array<[string, boolean, boolean?]>): Map<string, RegionHealth> {
  const m = new Map<string, RegionHealth>();
  for (const [region, nodeOnline, ingressHealthy] of entries) {
    m.set(region, { region, nodeOnline, ingressHealthy });
  }
  return m;
}

describe('computeRecordHealth', () => {
  it('is healthy when the region node is online and ingress is unknown', () => {
    expect(computeRecordHealth(rec('1', 'us-east', false), health([['us-east', true]]))).toBe(true);
  });

  it('is unhealthy when the region has no live signal', () => {
    expect(computeRecordHealth(rec('1', 'us-east', true), health([]))).toBe(false);
  });

  it('is unhealthy when no node is online in the region', () => {
    expect(computeRecordHealth(rec('1', 'us-east', true), health([['us-east', false]]))).toBe(false);
  });

  it('is unhealthy when ingress explicitly reports unhealthy', () => {
    expect(
      computeRecordHealth(rec('1', 'us-east', true), health([['us-east', true, false]])),
    ).toBe(false);
  });

  it('is healthy when both node online and ingress healthy', () => {
    expect(computeRecordHealth(rec('1', 'us-east', false), health([['us-east', true, true]]))).toBe(
      true,
    );
  });
});

describe('planReconcile', () => {
  it('produces no updates when all bits already match', () => {
    const records = [rec('1', 'us-east', true), rec('2', 'eu-west', true)];
    const h = health([
      ['us-east', true],
      ['eu-west', true],
    ]);
    const plan = planReconcile(records, h);
    expect(plan.updates).toHaveLength(0);
    expect(plan.healthySetChanged).toBe(false);
  });

  it('flips a record down when its region goes dark and marks the set changed', () => {
    const records = [rec('1', 'us-east', true), rec('2', 'eu-west', true)];
    const h = health([
      ['us-east', false],
      ['eu-west', true],
    ]);
    const plan = planReconcile(records, h);
    expect(plan.updates).toEqual([{ id: '1', healthy: false }]);
    expect(plan.healthySetChanged).toBe(true);
  });

  it('flips a record back up on recovery', () => {
    const records = [rec('1', 'us-east', false)];
    const plan = planReconcile(records, health([['us-east', true]]));
    expect(plan.updates).toEqual([{ id: '1', healthy: true }]);
    expect(plan.healthySetChanged).toBe(true);
  });

  it('reports only minimal flips', () => {
    const records = [rec('1', 'us-east', true), rec('2', 'eu-west', false)];
    const h = health([
      ['us-east', true],
      ['eu-west', true],
    ]);
    const plan = planReconcile(records, h);
    expect(plan.updates).toEqual([{ id: '2', healthy: true }]);
  });
});

describe('healthySignature', () => {
  it('is stable regardless of record order', () => {
    const a = [rec('1', 'us-east', true), rec('2', 'eu-west', true)];
    const b = [rec('2', 'eu-west', true), rec('1', 'us-east', true)];
    expect(healthySignature(a)).toBe(healthySignature(b));
  });

  it('changes when a record health bit flips', () => {
    const before = [rec('1', 'us-east', true), rec('2', 'eu-west', true)];
    const after = [rec('1', 'us-east', true), rec('2', 'eu-west', false)];
    expect(healthySignature(before)).not.toBe(healthySignature(after));
  });

  it('excludes unhealthy records from the signature', () => {
    expect(healthySignature([rec('1', 'us-east', false)])).toBe('');
  });
});
