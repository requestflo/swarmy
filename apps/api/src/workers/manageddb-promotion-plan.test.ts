import { describe, expect, it } from 'bun:test';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import { planPromotion, regionSlotTaken, writerGeoCarry, type PromotionInput } from './manageddb-promotion-plan';
import { promotedCopySpec } from './manageddb-reshape';

/**
 * The promotion pass's pure plan: the specs and labels every member ends
 * with. The writer is pinned to the server its data is on, whichever path
 * promoted it; a geo cluster's region declarations follow the writer.
 */

const node = (id: string, region: string) => ({ swarmNodeId: id, status: 'ready', availability: 'active', labels: { 'swarmy.region': region } });
const NODES = [node('node-a', 'us'), node('node-b', 'eu'), node('node-c', 'ap'), node('node-d', 'eu')];
const svc = (name: string, labels: Record<string, string>, desired = 1): SwarmServiceInfo =>
  ({ id: `id-${name}`, name, image: 'pgvector/pgvector:pg17', mode: 'replicated', desiredReplicas: desired, runningReplicas: desired, createdAt: 0, updatedAt: 0, labels, env: ['SWARMY_PG_ROLE=replica'], networks: [{ name: 'shop_db-net', aliases: [] }], ports: [], secrets: [], configs: [] }) as SwarmServiceInfo;

const pg = { 'swarmy.db.engine': 'postgres', 'swarmy.db.cluster': 'db' };
const GEO = { 'swarmy.db.writeRegion': 'us', 'swarmy.db.placedRegion': 'us', 'swarmy.db.region.eu.replicas': '2', 'swarmy.db.region.ap.replicas': '1' };
const writerOld = (topology: string, extra: Record<string, string> = {}) =>
  svc('shop_db-primary', { ...pg, 'swarmy.db.topology': topology, 'swarmy.db.role': 'primary', 'swarmy.db.dataVolume': 'shop_db-primary-data', 'swarmy.db.node': 'node-a', 'swarmy.db.memoryMb': '2048', ...extra });
const standby = (name: string, extra: Record<string, string>, desired = 1) =>
  svc(name, { ...pg, 'swarmy.db.role': 'replica', 'swarmy.db.avoidNode': 'node-a', 'swarmy.db.rolePlaced': 'true', ...extra }, desired);
const MARK = { 'swarmy.db.failover.promoting': 'node-b' };
const input = (o: Partial<PromotionInput> & Pick<PromotionInput, 'target' | 'standbys' | 'topology'>): PromotionInput =>
  ({ primary: writerOld(o.topology), node: 'node-b', reshape: false, net: 'shop_db-net', epoch: 'e1', nodes: NODES, ...o });

describe('planPromotion — the writer is pinned to the server its data is on', () => {
  it('a 1-copy standby: the flip carries the declarations, the pin spec is that one copy on its server', () => {
    const target = standby('shop_db-replica', { ...MARK, 'swarmy.db.topology': 'failover', 'swarmy.db.dataVolume': 'shop_db-replica-data' });
    const plan = planPromotion(input({ target, standbys: [target], topology: 'failover' }));
    expect(plan.writer).toEqual({ 'swarmy.db.role': 'primary', 'swarmy.db.leader': 'shop_db-replica', 'swarmy.db.memoryMb': '2048' });
    expect(plan.pin?.labels).toMatchObject({ 'swarmy.db.role': 'primary', 'swarmy.db.node': 'node-b', 'swarmy.db.memoryMb': '2048' });
    for (const gone of ['swarmy.db.avoidNode', 'swarmy.db.rolePlaced', 'swarmy.db.failover.promoting']) expect(plan.pin?.labels?.[gone]).toBeUndefined();
    expect(plan.pin?.placement?.constraints).toEqual(['node.id==node-b']);
    expect(plan.pin?.mode).toEqual({ replicated: { replicas: 1 } });
    expect(plan.pin?.updateConfig?.order).toBe('stop-first');
    expect(plan.repoint.map((s) => [s.name, s.labels?.['swarmy.db.role'], s.placement?.constraints])).toEqual([['shop_db-primary', 'replica', ['node.id==node-a']]]);
    expect(plan.writeRegion).toBeUndefined();
  });

  it('one copy of several: no pin spec (the reshape pins it); the demoted writer floats with the copies', () => {
    const target = standby('shop_db-replica', { ...MARK, 'swarmy.db.topology': 'failover', 'swarmy.db.replicas': '2' }, 2);
    const plan = planPromotion(input({ target, standbys: [target], topology: 'failover', reshape: true }));
    expect(plan.pin).toBeNull();
    expect(plan.writer['swarmy.db.memoryMb']).toBe('2048');
    const ex = plan.repoint[0]!;
    expect(ex.labels?.['swarmy.db.node']).toBeUndefined();
    expect(ex.labels?.['swarmy.db.avoidNode']).toBe('node-b');
    expect(ex.mode).toEqual({ replicated: { replicas: 2 } });
    // The reshape's pin step builds the writer from its flipped labels: pinned there.
    const pinned = promotedCopySpec({ ...target, labels: { ...target.labels, ...plan.writer } }, 'node-b', 'shop_db-net');
    expect(pinned.placement?.constraints).toEqual(['node.id==node-b']);
  });
});

describe('planPromotion — a geo cluster keeps its regional layout', () => {
  const eu = (desired = 1) => standby('shop_db-replica-eu', { ...MARK, 'swarmy.db.topology': 'geo', 'swarmy.db.region': 'eu', 'swarmy.db.replicas': String(desired) }, desired);
  const ap = standby('shop_db-replica-ap', { 'swarmy.db.topology': 'geo', 'swarmy.db.region': 'ap', 'swarmy.db.replicas': '1' });
  const geo = (target: SwarmServiceInfo, reshape = false) =>
    planPromotion(input({ primary: writerOld('geo', GEO), target, standbys: [target, ap], topology: 'geo', reshape }));

  it('the writer takes every region declaration and the region its data is in', () => {
    const plan = geo(eu());
    expect(plan.writer).toEqual({
      'swarmy.db.role': 'primary',
      'swarmy.db.leader': 'shop_db-replica-eu',
      'swarmy.db.memoryMb': '2048',
      'swarmy.db.region.eu.replicas': '2',
      'swarmy.db.region.ap.replicas': '1',
      'swarmy.db.writeRegion': 'eu',
      'swarmy.db.placedRegion': 'eu',
    });
    expect(plan.pin?.labels).toMatchObject({ ...plan.writer, 'swarmy.db.region': 'eu', 'swarmy.db.node': 'node-b' });
    expect(plan.pin?.placement?.constraints).toEqual(['node.labels.swarmy.region==eu', 'node.id==node-b']);
    expect(plan.writeRegion).toEqual({ from: 'us', to: 'eu' });
  });

  it('standbys keep their region and follow the write region; the demoted writer gives the declarations up', () => {
    const [ex, sib] = geo(eu()).repoint;
    expect(ex!.name).toBe('shop_db-primary');
    expect(ex!.labels).toMatchObject({ 'swarmy.db.role': 'replica', 'swarmy.db.writeRegion': 'eu', 'swarmy.db.node': 'node-a' });
    for (const k of ['swarmy.db.placedRegion', 'swarmy.db.region.eu.replicas', 'swarmy.db.region.ap.replicas', 'swarmy.db.region']) expect(ex!.labels?.[k]).toBeUndefined();
    expect(ex!.placement?.constraints).toEqual(['node.labels.swarmy.region==us', 'node.id==node-a']);
    expect(sib!.labels).toMatchObject({ 'swarmy.db.region': 'ap', 'swarmy.db.writeRegion': 'eu', 'swarmy.db.leader': 'shop_db-replica-eu' });
    expect(sib!.placement?.constraints).toEqual(['node.labels.swarmy.region==ap', 'node.id!=node-a']);
  });

  it('one copy of a multi-copy sibling: the declarations ride the flip, the reshape pins it in its region', () => {
    const target = eu(2);
    const plan = geo(target, true);
    expect(plan.pin).toBeNull();
    expect(plan.writer['swarmy.db.region.ap.replicas']).toBe('1');
    const pinned = promotedCopySpec({ ...target, labels: { ...target.labels, ...plan.writer } }, 'node-b', 'shop_db-net');
    expect(pinned.labels).toMatchObject({ 'swarmy.db.region.eu.replicas': '2', 'swarmy.db.writeRegion': 'eu', 'swarmy.db.node': 'node-b' });
    expect(pinned.placement?.constraints).toEqual(['node.labels.swarmy.region==eu', 'node.id==node-b']);
    // The demoted writer stays on its data in a geo cluster (never floated).
    expect(plan.repoint[0]!.placement?.constraints).toEqual(['node.labels.swarmy.region==us', 'node.id==node-a']);
  });
});

describe('writerGeoCarry', () => {
  it('never invents a write region; an unknown region keeps the declared one, unplaced', () => {
    expect(writerGeoCarry({ 'swarmy.db.region.eu.replicas': '1' }, 'eu')).toEqual({ 'swarmy.db.region.eu.replicas': '1' });
    expect(writerGeoCarry({ 'swarmy.db.writeRegion': 'us', 'swarmy.db.placedRegion': 'us' }, undefined)).toEqual({ 'swarmy.db.writeRegion': 'us' });
    expect(writerGeoCarry(undefined, 'eu')).toEqual({});
  });
});

describe('regionSlotTaken', () => {
  it('the writer promoted from the eu sibling holds the eu slot; ap stays free', () => {
    expect(regionSlotTaken('shop_db', 'eu', 'shop_db-replica-eu')).toBe(true);
    expect(regionSlotTaken('shop_db', 'ap', 'shop_db-replica-eu')).toBe(false);
    expect(regionSlotTaken('shop_db', 'eu', 'shop_db-primary')).toBe(false);
  });
});
