import { describe, expect, it } from 'bun:test';
import type { SwarmNodeInfo } from '@swarmy/core/protocol';
import { statusOf } from './node.service';

/** Minimal live swarm-node info (only the fields statusOf reads). */
function info(over: Partial<SwarmNodeInfo> = {}): SwarmNodeInfo {
  return {
    swarmNodeId: 'n1',
    hostname: 'node-1',
    role: 'manager',
    status: 'ready',
    availability: 'active',
    labels: {},
    engineVersion: '',
    os: '',
    arch: '',
    addr: '',
    cpus: 4,
    memBytes: 0,
    ...over,
  } as SwarmNodeInfo;
}

describe('statusOf — node health vs swarm membership', () => {
  it('online + active swarm ⇒ online', () => {
    expect(statusOf(info(), true, true, 'active')).toBe('online');
  });

  it('online but the swarm was LEFT ⇒ degraded, never online', () => {
    // The regression: agent WebSocket is up (online) but `docker swarm leave`
    // ran, so the node cannot run workloads. Must not read as a healthy node.
    expect(statusOf(undefined, true, true, 'inactive')).toBe('degraded');
    expect(statusOf(info(), true, true, 'inactive')).toBe('degraded');
  });

  it('online but mid-join (pending) or locked ⇒ degraded', () => {
    expect(statusOf(undefined, true, true, 'pending')).toBe('degraded');
    expect(statusOf(undefined, true, true, 'locked')).toBe('degraded');
  });

  it('draining wins over everything (operator intent)', () => {
    expect(statusOf(info({ availability: 'drain' }), true, true, 'active')).toBe('draining');
  });

  it('legacy agent (no swarmState) trusts the connection ⇒ online', () => {
    expect(statusOf(info(), true, true, undefined)).toBe('online');
  });

  it('disconnected node ⇒ offline (or pending if never seen)', () => {
    expect(statusOf(info(), false, true, 'active')).toBe('offline');
    expect(statusOf(undefined, false, false, undefined)).toBe('pending');
  });
});
