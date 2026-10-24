import { describe, expect, test } from 'bun:test';
import { externalRelaysOf, planEdgeRelays, relayHostname, relayPortsClash } from './relays';
import { renderMeshControlConfig } from './server-config';

const KEY = Buffer.alloc(32, 7).toString('base64');
const base = {
  meshDomain: 'mesh.example.com',
  tls: { mode: 'edge' as const, listen: '172.17.0.1:8081' },
  authSecret: 'relay-secret-0123456789',
  encryptionKey: KEY,
  localAuthDisabled: true,
};
const server = (yaml: string) => JSON.parse(yaml.split('\n').slice(1).join('\n')).server;

describe('relays on edges: names, plan, control-plane config', () => {
  test('one name per edge under the wildcard-IP base', () => {
    expect(relayHostname('203.0.113.7', 'sslip.io')).toBe('relay.203-0-113-7.sslip.io');
    expect(relayHostname('203.0.113.7', 'Apps.Example.com.')).toBe('relay.203-0-113-7.apps.example.com');
    expect(relayHostname('203.0.113.256', 'sslip.io')).toBeNull();
    expect(relayHostname('203.0.113.7', 'localhost')).toBeNull();
    expect(relayHostname('203.0.113.7', 'bad host.io')).toBeNull();
  });

  test('plan: sorted by host, one relay per public IP, upstream on the mesh address; none without one', () => {
    const plan = planEdgeRelays(
      [
        { nodeId: 'n2', hostname: 'nyc-1', publicIp: '198.51.100.20', meshIp: '100.92.0.2' },
        { nodeId: 'n1', hostname: 'lon-1', publicIp: '198.51.100.10', meshIp: '100.92.0.1' },
        { nodeId: 'n0', hostname: 'lon-1-dup', publicIp: '198.51.100.10', meshIp: '100.92.0.9' },
        { nodeId: 'n3', hostname: 'fresh', publicIp: '198.51.100.30', meshIp: null },
      ],
      'sslip.io',
    );
    expect(plan).toEqual([
      { nodeId: 'n0', hostname: 'lon-1-dup', host: 'relay.198-51-100-10.sslip.io', address: 'rels://relay.198-51-100-10.sslip.io:443', upstream: '100.92.0.9:33080', stun: 'stun:198.51.100.10:3478' },
      { nodeId: 'n2', hostname: 'nyc-1', host: 'relay.198-51-100-20.sslip.io', address: 'rels://relay.198-51-100-20.sslip.io:443', upstream: '100.92.0.2:33080', stun: 'stun:198.51.100.20:3478' },
    ]);
    expect(planEdgeRelays([{ nodeId: 'a', hostname: 'a', publicIp: '198.51.100.10', meshIp: '100.92.0.4' }], 'sslip.io', 8443)[0]!.address).toBe(
      'rels://relay.198-51-100-10.sslip.io:8443',
    );
    expect(externalRelaysOf([])).toBeNull();
    expect(externalRelaysOf(plan)).toEqual({
      addresses: plan.map((r) => r.address),
      stuns: ['stun:198.51.100.10:3478', 'stun:198.51.100.20:3478'],
    });
  });

  test("the relay's private ports never clash with the control plane's on the same host", () => {
    expect(relayPortsClash()).toEqual([]);
  });

  test('without edge relays the config is unchanged: NetBird keeps its own relay + STUN', () => {
    const plain = server(renderMeshControlConfig(base));
    expect(plain.relays).toBeUndefined();
    expect(plain.stuns).toBeUndefined();
    expect(renderMeshControlConfig({ ...base, externalRelays: null })).toBe(renderMeshControlConfig(base));
    expect(renderMeshControlConfig({ ...base, externalRelays: { addresses: [], stuns: [] } })).toBe(renderMeshControlConfig(base));
  });

  test('with edge relays: relays + STUN listed together, sorted, sharing the auth secret', () => {
    const s = server(
      renderMeshControlConfig({
        ...base,
        externalRelays: { addresses: ['rels://relay.2-2-2-2.sslip.io:443', 'rels://relay.1-1-1-1.sslip.io:443'], stuns: ['stun:2.2.2.2:3478', 'stun:1.1.1.1:3478'] },
      }),
    );
    expect(s.relays).toEqual({
      addresses: ['rels://relay.1-1-1-1.sslip.io:443', 'rels://relay.2-2-2-2.sslip.io:443'],
      credentialsTTL: '12h',
      secret: 'relay-secret-0123456789',
    });
    expect(s.stuns).toEqual([
      { proto: 'udp', uri: 'stun:1.1.1.1:3478' },
      { proto: 'udp', uri: 'stun:2.2.2.2:3478' },
    ]);
  });

  test('refuses relays without STUN (NetBird would advertise a STUN nobody serves) and bad URIs', () => {
    expect(() => renderMeshControlConfig({ ...base, externalRelays: { addresses: ['rels://r.x:443'], stuns: [] } })).toThrow(/STUN/);
    expect(() => renderMeshControlConfig({ ...base, externalRelays: { addresses: ['https://r.x'], stuns: ['stun:1.1.1.1:3478'] } })).toThrow(/rels/);
    expect(() => renderMeshControlConfig({ ...base, externalRelays: { addresses: ['rels://r.x:443'], stuns: ['1.1.1.1'] } })).toThrow(/stun/);
  });
});
