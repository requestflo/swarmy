import { describe, expect, test } from 'bun:test';
import { meshRelaySpecHash } from '@swarmy/core/protocol';
import { decideRelays, relaySpecFor, sameRelays, type RelayDecisionInput } from './relay-plan';
import { planEdgeRelays } from './relays';

const planned = planEdgeRelays(
  [
    { nodeId: 'cp', hostname: 'lon-1', publicIp: '198.51.100.10', meshIp: '100.92.0.1' },
    { nodeId: 'e2', hostname: 'nyc-1', publicIp: '198.51.100.20', meshIp: '100.92.0.2' },
  ],
  'sslip.io',
);
const base: RelayDecisionInput = {
  wanted: true,
  planned,
  controlNodeId: 'cp',
  active: null,
  controlRunsExternal: false,
  reports: [],
  image: 'ghcr.io/netbirdio/relay:0.79.0',
  authSecret: 'relay-secret-0123456789',
};
const list = {
  addresses: ['rels://relay.198-51-100-10.sslip.io:443', 'rels://relay.198-51-100-20.sslip.io:443'],
  stuns: ['stun:198.51.100.10:3478', 'stun:198.51.100.20:3478'],
};
const hashOf = (nodeId: string, input = base) => meshRelaySpecHash(relaySpecFor(planned.find((r) => r.nodeId === nodeId)!, input));

describe('relays on edges: one reconcile decision', () => {
  test('first tick: every edge gets a relay; the control node without STUN; nothing listed yet', () => {
    const d = decideRelays(base);
    expect(d.apply.map((a) => [a.nodeId, a.spec.stun, a.spec.exposedAddress])).toEqual([
      ['cp', false, 'rels://relay.198-51-100-10.sslip.io:443'],
      ['e2', true, 'rels://relay.198-51-100-20.sslip.io:443'],
    ]);
    expect(d.stop).toEqual([]);
    expect(d.next).toBeNull();
  });

  test('one healthy relay switches the control plane over, listing every planned relay', () => {
    const d = decideRelays({ ...base, reports: [{ nodeId: 'e2', running: true, healthy: true, specHash: hashOf('e2') }] });
    expect(d.apply.map((a) => a.nodeId)).toEqual(['cp']);
    expect(d.next).toEqual(list);
  });

  test('once NetBird runs the external config the control node relay takes STUN; steady state sends nothing', () => {
    const on = { ...base, active: list, controlRunsExternal: true };
    expect(decideRelays(on).apply.map((a) => [a.nodeId, a.spec.stun])).toEqual([
      ['cp', true],
      ['e2', true],
    ]);
    const steady = decideRelays({
      ...on,
      reports: [
        { nodeId: 'cp', running: true, healthy: true, specHash: hashOf('cp', on) },
        { nodeId: 'e2', running: true, healthy: true, specHash: hashOf('e2', on) },
      ],
    });
    expect(steady).toEqual({ apply: [], stop: [], next: list });
  });

  test('a flapping edge never changes the list once active (identity, not health)', () => {
    const d = decideRelays({ ...base, active: list, reports: [{ nodeId: 'e2', running: false, healthy: false }] });
    expect(sameRelays(d.next, list)).toBe(true);
  });

  test('turning it off (or losing every edge) stops every relay and lists nothing', () => {
    const reports = [
      { nodeId: 'cp', running: true, healthy: true },
      { nodeId: 'e2', running: true, healthy: true },
    ];
    expect(decideRelays({ ...base, wanted: false, active: list, reports })).toEqual({ apply: [], stop: ['cp', 'e2'], next: null });
    expect(decideRelays({ ...base, planned: [], active: list, reports })).toEqual({ apply: [], stop: ['cp', 'e2'], next: null });
  });

  test('a relay on a node that is no longer an edge is stopped; the list follows', () => {
    const d = decideRelays({
      ...base,
      planned: planned.filter((r) => r.nodeId === 'e2'),
      active: list,
      reports: [{ nodeId: 'cp', running: true, healthy: true }],
    });
    expect(d.stop).toEqual(['cp']);
    expect(d.next).toEqual({ addresses: [list.addresses[1]!], stuns: [list.stuns[1]!] });
  });

  test('sameRelays ignores order', () => {
    expect(sameRelays(list, { addresses: [...list.addresses].reverse(), stuns: [...list.stuns].reverse() })).toBe(true);
    expect(sameRelays(list, null)).toBe(false);
    expect(sameRelays(null, undefined)).toBe(true);
  });
});
