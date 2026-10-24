import { describe, expect, it } from 'bun:test';
import { agentSkew } from './skew';
import { PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from './constants';

describe('agentSkew — agent ↔ controller version skew', () => {
  it('the controller speaks its own protocol version', () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(PROTOCOL_VERSION);
  });

  it('same release, shared protocol → ok', () => {
    expect(agentSkew('1.4.0', '1.4.0', [1])).toEqual({ status: 'ok', versions: null });
    expect(agentSkew('v1.4.0', '1.4.0', [1])).toEqual({ status: 'ok', versions: null });
  });

  it('an older agent is behind, counted in the part that differs', () => {
    expect(agentSkew('1.4.0', '1.2.0', [1])).toEqual({ status: 'behind', versions: 2 });
    expect(agentSkew('1.4.3', '1.4.1', [1])).toEqual({ status: 'behind', versions: 2 });
    expect(agentSkew('2.0.0', '1.9.3', [1])).toEqual({ status: 'behind', versions: 1 });
    expect(agentSkew('1.4.0', '1.4.0-edge.3', [1])).toEqual({ status: 'behind', versions: 1 });
  });

  it('a newer agent is ahead', () => {
    expect(agentSkew('1.2.0', '1.3.0', [1])).toEqual({ status: 'ahead', versions: 1 });
  });

  it('no protocol in common → incompatible, whatever the releases say', () => {
    expect(agentSkew('1.4.0', '1.4.0', [2])).toEqual({ status: 'incompatible', versions: null });
    expect(agentSkew('1.4.0', '0.1.0', [0], [1, 2])).toEqual({ status: 'incompatible', versions: null });
  });

  it('a shared protocol among several keeps it compatible', () => {
    expect(agentSkew('1.4.0', '1.4.0', [1, 2], [2, 3])).toEqual({ status: 'ok', versions: null });
  });

  it('unversioned (dev) builds fall back on the newest protocol each side speaks', () => {
    expect(agentSkew('dev', 'dev', [1])).toEqual({ status: 'ok', versions: null });
    expect(agentSkew('0.0.0', 'dev', [1], [1, 2])).toEqual({ status: 'behind', versions: null });
    expect(agentSkew('dev', '1.0.0', [1, 2], [1])).toEqual({ status: 'ahead', versions: null });
  });
});
