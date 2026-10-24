import { describe, expect, it } from 'bun:test';
import type { AgentHub } from '../hub/types';
import {
  desiredRegistryTopology,
  forwardersReady,
  liveRegistryTopology,
  publishesRegistryPort,
  registryTopologyFor,
  registryTopologySignature,
} from './registry-topology';

const swarmy = [{ name: 'swarmy', aliases: [] }];
const meshRegistry = { ports: [{ target: 5000, published: 5000, protocol: 'tcp' as const }], networks: swarmy };
const meshCache = { ports: [{ target: 5000, published: 5001, protocol: 'tcp' as const }], networks: [] };
const loopback = { ports: [], networks: swarmy };

describe('liveRegistryTopology (M16)', () => {
  it('a published :5000/:5001 is the routing mesh; loopback needs no port AND the swarmy overlay', () => {
    expect(publishesRegistryPort(meshRegistry)).toBe(true);
    expect(publishesRegistryPort(meshCache)).toBe(true);
    expect(liveRegistryTopology(meshRegistry)).toBe('mesh');
    expect(liveRegistryTopology(meshCache)).toBe('mesh');
    expect(liveRegistryTopology(loopback)).toBe('loopback');
    // No port but not on the overlay the forwarders reach it over: not moved.
    expect(liveRegistryTopology({ ports: [], networks: [] })).toBe('mesh');
    // Another published port is not a registry port.
    expect(liveRegistryTopology({ ports: [{ target: 9000, published: 9000, protocol: 'tcp' }], networks: swarmy })).toBe('loopback');
  });
});

describe('forwardersReady', () => {
  const nodes = [
    { swarmNodeId: 'a', status: 'ready' as const },
    { swarmNodeId: 'b', status: 'ready' as const },
    { swarmNodeId: 'c', status: 'down' as const },
  ];

  it('needs an online agent reporting `on` on EVERY ready node', () => {
    expect(forwardersReady(nodes, [{ swarmNodeId: 'a', forwarder: 'on' }, { swarmNodeId: 'b', forwarder: 'on' }])).toBe(true);
    // b's agent predates the forwarder, opted out, or is offline.
    expect(forwardersReady(nodes, [{ swarmNodeId: 'a', forwarder: 'on' }, { swarmNodeId: 'b' }])).toBe(false);
    expect(forwardersReady(nodes, [{ swarmNodeId: 'a', forwarder: 'on' }, { swarmNodeId: 'b', forwarder: 'off' }])).toBe(false);
    expect(forwardersReady(nodes, [{ swarmNodeId: 'a', forwarder: 'on' }])).toBe(false);
  });

  it('a cold hub (no ready node known) is never ready', () => {
    expect(forwardersReady([], [])).toBe(false);
    expect(forwardersReady([{ swarmNodeId: 'c', status: 'down' }], [{ swarmNodeId: 'c', forwarder: 'on' }])).toBe(false);
  });
});

describe('desiredRegistryTopology', () => {
  it('moves only when every node forwards', () => {
    expect(desiredRegistryTopology({ registry: meshRegistry, cache: meshCache, forwardersReady: false })).toBe('mesh');
    expect(desiredRegistryTopology({ registry: meshRegistry, cache: meshCache, forwardersReady: true })).toBe('loopback');
    expect(desiredRegistryTopology({ forwardersReady: true })).toBe('loopback'); // a fresh install
    expect(desiredRegistryTopology({ forwardersReady: false })).toBe('mesh');
  });

  it('is one-way: once either service runs loopback it never goes back to the mesh', () => {
    expect(desiredRegistryTopology({ registry: loopback, cache: meshCache, forwardersReady: false })).toBe('loopback');
    expect(desiredRegistryTopology({ registry: meshRegistry, cache: loopback, forwardersReady: false })).toBe('loopback');
  });
});

/** A hub with swarm nodes a/b and their agents' register facts. */
function hub(forwarders: Record<string, 'on' | 'off' | undefined>, services: Array<Record<string, unknown>> = []) {
  const ids = Object.keys(forwarders);
  return {
    liveInventory: () => ({ services, containers: [] }),
    nodeInventory: () => ids.map((id) => ({ swarmNodeId: `swarm-${id}`, status: 'ready' })),
    onlineNodeIds: () => [...ids, 'other-org-node'],
    swarmNodeIdFor: (id: string) => (id === 'other-org-node' ? 'swarm-elsewhere' : `swarm-${id}`),
    agentBuildFor: (id: string) => ({ version: '1', registryForwarder: forwarders[id] }),
  } as unknown as AgentHub;
}

describe('registryTopologyFor (hub reads)', () => {
  const reg = { name: 'swarmy-registry', ...meshRegistry };

  it('reads every ready node of THIS org through its agent facts', () => {
    expect(registryTopologyFor(hub({ n1: 'on', n2: 'on' }, [reg]), 'o1')).toBe('loopback');
    expect(registryTopologyFor(hub({ n1: 'on', n2: undefined }, [reg]), 'o1')).toBe('mesh');
  });

  it('keeps the status quo when the hub cannot answer', () => {
    const broken = { liveInventory: () => ({ services: [reg], containers: [] }) } as unknown as AgentHub;
    expect(registryTopologyFor(broken, 'o1')).toBe('mesh');
  });
});

describe('registryTopologySignature', () => {
  it('changes with the wanted topology or either live one, nothing else', () => {
    const a = registryTopologySignature('loopback', { registry: meshRegistry, cache: meshCache });
    expect(a).toBe('loopback|registry=mesh|cache=mesh');
    expect(registryTopologySignature('loopback', { registry: loopback, cache: meshCache })).not.toBe(a);
    expect(registryTopologySignature('loopback', {})).toBe('loopback|registry=absent|cache=absent');
  });
});
