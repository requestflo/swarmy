import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { ServiceSpec, SwarmServiceInfo } from '@swarmy/core/protocol';
import { hub } from '../gateway';
import { copiesSwarm } from './manageddb-copies.fake';
import { guardWriter, resetWriterGuard, type WriterGuardIo } from './manageddb-writer-guard';
import { planWriterRepair, type WriterRepairInput } from './manageddb-writer-repair';

/**
 * The reconcile's writer guard: a writer a promotion left unpinned, or a geo
 * writer that lost its region declarations (both promotions predating the
 * fix), is repaired on the next tick — once (signature-gated), audited, on
 * the cluster timeline.
 */

const node = (id: string, region: string) => ({ swarmNodeId: id, status: 'ready', availability: 'active', labels: { 'swarmy.region': region } });
const NODES = [node('swarm-a', 'us'), node('swarm-b', 'eu'), node('swarm-c', 'ap')];
const svc = (name: string, labels: Record<string, string>): SwarmServiceInfo =>
  ({ id: `id-${name}`, name, image: 'pgvector/pgvector:pg17', mode: 'replicated', desiredReplicas: 1, runningReplicas: 1, createdAt: 0, updatedAt: 0, labels, env: ['SWARMY_PG_ROLE=replica'], networks: [{ name: 'shop_main-net', aliases: [] }], ports: [], secrets: [], configs: [] }) as SwarmServiceInfo;
const pg = (topology: string) => ({ 'swarmy.db.engine': 'postgres', 'swarmy.db.cluster': 'main', 'swarmy.db.topology': topology });
/** A writer promoted before the fix: standby placement kept, nothing carried. */
const promoted = (topology: string, extra: Record<string, string> = {}) =>
  svc('shop_main-replica-eu', { ...pg(topology), 'swarmy.db.role': 'primary', 'swarmy.db.region': 'eu', 'swarmy.db.dataVolume': 'shop_main-replica-eu-data', 'swarmy.db.avoidNode': 'swarm-a', ...extra });
const GEO = { 'swarmy.db.writeRegion': 'us', 'swarmy.db.placedRegion': 'us', 'swarmy.db.region.eu.replicas': '1', 'swarmy.db.region.ap.replicas': '1' };
const demoted = (extra: Record<string, string> = GEO) => svc('shop_main-primary', { ...pg('geo'), 'swarmy.db.role': 'replica', 'swarmy.db.node': 'swarm-a', ...extra });
const input = (writer: SwarmServiceInfo, o: Partial<WriterRepairInput> = {}): WriterRepairInput =>
  ({ base: 'shop_main', topology: 'geo', writer, others: [demoted()], copyNodes: ['swarm-b'], nodes: NODES, net: 'shop_main-net', now: Date.now(), ...o });

describe('planWriterRepair', () => {
  it('an unpinned geo writer: pinned to its running copy, declarations back (its region the write region), taken off the demoted writer', () => {
    const r = planWriterRepair(input(promoted('geo')))!;
    expect(r.pinnedTo).toBe('swarm-b');
    expect(r.spec?.labels).toMatchObject({ 'swarmy.db.node': 'swarm-b', 'swarmy.db.region.eu.replicas': '1', 'swarmy.db.region.ap.replicas': '1', 'swarmy.db.writeRegion': 'eu', 'swarmy.db.placedRegion': 'eu' });
    expect(r.spec?.labels?.['swarmy.db.avoidNode']).toBeUndefined();
    expect(r.spec?.placement?.constraints).toEqual(['node.labels.swarmy.region==eu', 'node.id==swarm-b']);
    expect(r.spec?.updateConfig?.order).toBe('stop-first');
    expect(r.strip).toEqual([{ service: 'shop_main-primary', removeKeys: ['swarmy.db.placedRegion', 'swarmy.db.region.ap.replicas', 'swarmy.db.region.eu.replicas'] }]);
  });

  it('a pinned geo writer missing only its declarations: a labels-only update', () => {
    const r = planWriterRepair(input(promoted('geo', { 'swarmy.db.node': 'swarm-b' })))!;
    expect(r.spec).toBeNull();
    expect(r.add).toEqual({ 'swarmy.db.region.eu.replicas': '1', 'swarmy.db.region.ap.replicas': '1', 'swarmy.db.writeRegion': 'eu', 'swarmy.db.placedRegion': 'eu' });
  });

  it('a non-geo writer: only the pin; a PITR writer is labelled and its marker dropped (PITR redeploys it)', () => {
    expect(planWriterRepair(input(promoted('failover'), { topology: 'failover' }))?.restored).toEqual([]);
    const pitr = planWriterRepair(input(promoted('failover', { 'swarmy.db.pitr.applied': 'v1' }), { topology: 'failover' }))!;
    expect([pitr.spec, pitr.add, pitr.removeKeys]).toEqual([null, { 'swarmy.db.node': 'swarm-b' }, ['swarmy.db.pitr.applied']]);
  });

  it('never guesses, never fights: no copy / two copies / mid-flight / the canonical primary / nothing held', () => {
    const nonGeo = { topology: 'failover', others: [] };
    expect(planWriterRepair(input(promoted('failover'), { ...nonGeo, copyNodes: [] }))).toBeNull();
    expect(planWriterRepair(input(promoted('failover'), { ...nonGeo, copyNodes: ['swarm-b', 'swarm-c'] }))).toBeNull();
    expect(planWriterRepair(input(promoted('geo', { 'swarmy.db.failover.promoting': 'swarm-b' })))).toBeNull();
    expect(planWriterRepair(input(promoted('geo', { 'swarmy.db.switchover': '{}' })))).toBeNull();
    expect(planWriterRepair(input({ ...promoted('failover'), name: 'shop_main-primary' }, nonGeo))).toBeNull();
    // The operator removed the last region: nobody else holds one, so nothing comes back.
    const declared = promoted('geo', { 'swarmy.db.node': 'swarm-b', 'swarmy.db.writeRegion': 'eu' });
    expect(planWriterRepair(input(declared, { others: [demoted({ 'swarmy.db.writeRegion': 'eu' })] }))).toBeNull();
  });
});

describe('guardWriter — repaired on the next tick, once, audited, on the timeline', () => {
  let swarm: ReturnType<typeof copiesSwarm> | null = null;
  beforeEach(() => resetWriterGuard());
  afterEach(() => {
    swarm?.uninstall();
    swarm = null;
  });

  it('pins the unpinned geo writer on the fake swarm and puts the regions back; the next tick sends nothing', async () => {
    const s = (swarm = copiesSwarm('org-guard', { 'swarm-a': { 'swarmy.region': 'us' }, 'swarm-b': { 'swarmy.region': 'eu' }, 'swarm-c': { 'swarmy.region': 'ap' } }));
    const w = promoted('geo');
    s.put({ name: w.name, image: w.image, labels: w.labels, env: { SWARMY_PG_ROLE: 'replica' }, networks: ['shop_main-net'], placement: { constraints: ['node.labels.swarmy.region==eu', 'node.id!=swarm-a'] } });
    s.put({ name: 'shop_main-primary', image: w.image, labels: demoted().labels, env: { SWARMY_PG_ROLE: 'replica' }, networks: ['shop_main-net'], placement: { constraints: ['node.id==swarm-a'] } });
    s.install();
    const sent: string[] = [];
    const audits: Array<Record<string, unknown>> = [];
    const timeline: string[] = [];
    const io: WriterGuardIo = {
      deploy: (spec: ServiceSpec) => (sent.push(`deploy ${spec.name}`), hub.dispatch('n1', 'service.deploy', { spec }).then(() => true)),
      setLabels: (service, add, removeKeys) => (sent.push(`labels ${service}`), hub.dispatch('n1', 'service.updateLabels', { service, add, removeKeys }).then(() => true)),
      audit: async (m) => audits.push(m),
      incident: async (m) => timeline.push(m),
    };
    const tick = () => {
      const services = hub.liveInventory('org-guard').services;
      const writer = services.find((x) => x.name === w.name)!;
      return guardWriter('org-guard/shop/main', 'main', input(writer, { others: services.filter((x) => x !== writer), copyNodes: s.nodesOf(w.name) }), io);
    };
    expect(s.nodesOf(w.name)).toEqual(['swarm-b']);
    expect((await tick())?.pinnedTo).toBe('swarm-b');
    expect(sent).toEqual(['deploy shop_main-replica-eu', 'labels shop_main-primary']);
    const spec = s.services.get(w.name)!.spec;
    expect(spec.placement?.constraints).toEqual(['node.labels.swarmy.region==eu', 'node.id==swarm-b']);
    expect(spec.labels).toMatchObject({ 'swarmy.db.region.ap.replicas': '1', 'swarmy.db.writeRegion': 'eu' });
    expect(s.services.get('shop_main-primary')!.spec.labels?.['swarmy.db.region.ap.replicas']).toBeUndefined();
    expect(audits).toEqual([{ writer: w.name, pinnedTo: 'swarm-b', restored: ['swarmy.db.placedRegion', 'swarmy.db.region.ap.replicas', 'swarmy.db.region.eu.replicas', 'swarmy.db.writeRegion'], stripped: ['shop_main-primary'] }]);
    expect(timeline[0]).toContain('pinned shop_main-replica-eu to swarm-b, the server its data is on');
    expect(await tick()).toBeNull();
    expect(sent).toHaveLength(2);
    expect(audits).toHaveLength(1);
  });

  it('the same repair is not sent twice while the inventory lags; a failed send is retried', async () => {
    const calls: string[] = [];
    let ok = false;
    const io: WriterGuardIo = { deploy: async () => (calls.push('deploy'), ok), setLabels: async () => true, audit: async () => calls.push('audit'), incident: async () => calls.push('incident') };
    const same = input(promoted('failover'), { topology: 'failover', others: [] });
    expect(await guardWriter('k', 'main', same, io)).toBeNull();
    ok = true;
    expect(await guardWriter('k', 'main', same, io)).not.toBeNull();
    expect(await guardWriter('k', 'main', same, io)).toBeNull();
    expect(calls).toEqual(['deploy', 'deploy', 'audit', 'incident']);
  });
});
